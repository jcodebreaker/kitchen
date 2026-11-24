// A Slack channel as an outer-loop source (ADR 0022, amendment), read by code with the workspace's own internal
// Kitchen app (slack-app-manifest.json; internal apps keep Slack's normal rate limits): `conversations.history` from
// the watermark less an overlap (a reaction added a day later is still seen), the messages that carry the source's
// emoji, each with its thread (`conversations.replies`). Any call that fails (a bad token, the app not in the channel,
// a rate limit, no network) makes the whole read "unavailable": nothing is added and the watermark stays.

import type { SlackSource, SourceState } from "./config.ts";
import type { RawItem, ReadResult } from "./github.ts";

/** Refetched behind the watermark, so an emoji added to a message up to two days old is still collected. */
export const SLACK_OVERLAP_SECS = 2 * 24 * 3600;
/** The first collect reads this far back. */
export const SLACK_FIRST_SECS = 14 * 24 * 3600;
const MAX_PAGES = 20;

type Fetch = typeof fetch;
type Msg = {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  reply_count?: number;
  thread_ts?: string;
  reactions?: { name: string }[];
};
type Api = { ok?: boolean; error?: string; messages?: Msg[]; has_more?: boolean; response_metadata?: { next_cursor?: string }; user?: unknown; url?: string };

export const slackApi = (env: NodeJS.ProcessEnv = process.env) => (env.KITCHEN_SLACK_API || "https://slack.com/api").replace(/\/$/, "");

/** Pure: the message carries the emoji (`kitchen`, or `kitchen::skin-tone-2`). */
export const hasEmoji = (m: Pick<Msg, "reactions">, emoji: string) => (m.reactions ?? []).some((r) => r.name.split("::")[0] === emoji);

/** Pure: a Slack ts ("1732440000.000200") as ISO time. */
export const tsIso = (ts: string) => new Date(Math.floor(Number(ts) * 1000)).toISOString();

/** Pure: the permalink the Slack client opens (archives/<channel>/p<ts without the dot>). */
export const permalink = (teamUrl: string | undefined, channel: string, ts: string) =>
  teamUrl ? `${teamUrl.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}` : undefined;

export async function readSlack(s: SlackSource, st: SourceState, o: { token: string | null; fetch?: Fetch; api?: string; now?: number }): Promise<ReadResult> {
  if (!o.token) return { ok: false, error: "no Slack token: create the Kitchen app (kitchen sources add slack says how), then kitchen sources slack-token" };
  const f = o.fetch ?? fetch;
  const api = o.api ?? slackApi();
  const call = async (method: string, params: Record<string, string>): Promise<Api> => {
    const r = await f(`${api}/${method}?${new URLSearchParams(params).toString()}`, {
      headers: { authorization: `Bearer ${o.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 429) throw new Error(`${method}: rate limited (retry after ${r.headers.get("retry-after") ?? "?"} s)`);
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const d = (await r.json()) as Api;
    if (!d.ok)
      throw new Error(`${method}: ${d.error ?? "not ok"}${d.error === "not_in_channel" ? " (invite the Kitchen app to the channel: /invite @Kitchen)" : ""}`);
    return d;
  };
  try {
    const now = (o.now ?? Date.now()) / 1000;
    const oldest = st.watermark ? Number(st.watermark) - SLACK_OVERLAP_SECS : now - SLACK_FIRST_SECS;
    const users = { ...(st.users ?? {}) };
    let teamUrl = st.teamUrl;
    if (!teamUrl) teamUrl = (await call("auth.test", {})).url;
    const msgs: Msg[] = [];
    let cursor = "";
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES} pages of messages since the last collect`);
      const d = await call("conversations.history", {
        channel: s.channel,
        oldest: oldest.toFixed(6),
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      msgs.push(...(d.messages ?? []));
      cursor = d.response_metadata?.next_cursor ?? "";
      if (!d.has_more || !cursor) break;
    }
    let watermark = st.watermark;
    for (const m of msgs) if (!watermark || Number(m.ts) > Number(watermark)) watermark = m.ts;
    const name = async (u: string | undefined) => {
      if (!u) return undefined;
      if (!users[u]) {
        const d = (await call("users.info", { user: u })) as { user?: { name?: string; real_name?: string; profile?: { display_name?: string } } };
        users[u] = d.user?.profile?.display_name || d.user?.real_name || d.user?.name || u;
      }
      return users[u];
    };
    const items: RawItem[] = [];
    const chan = s.channelName ?? s.channel;
    for (const m of msgs.filter((x) => hasEmoji(x, s.emoji)).sort((a, b) => Number(a.ts) - Number(b.ts))) {
      const by = await name(m.user);
      let text = (m.text ?? "").trim();
      if ((m.reply_count ?? 0) > 0) {
        const t = await call("conversations.replies", { channel: s.channel, ts: m.ts, limit: "200" });
        const replies = (t.messages ?? []).filter((r) => r.ts !== m.ts);
        const lines: string[] = [];
        for (const r of replies) lines.push(`${(await name(r.user)) ?? "someone"}: ${(r.text ?? "").trim()}`);
        if (lines.length) text += `\n\nThread:\n${lines.join("\n")}`;
      }
      items.push({
        key: `slack:${s.channel}:${m.ts}`,
        text,
        // An edit to the report is a new sighting; a reply in its thread is not.
        hashText: (m.text ?? "").trim(),
        at: tsIso(m.ts),
        url: permalink(teamUrl, s.channel, m.ts),
        by,
        ref: m.ts,
        label: `Slack ${chan}`,
      });
    }
    return { ok: true, items, state: { watermark, users, ...(teamUrl ? { teamUrl } : {}) } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
