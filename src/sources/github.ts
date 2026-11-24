// GitHub issues as an outer-loop source (ADR 0022, amendment), read by code through `gh api` (the person's own login):
// open issues with the source's label, `since` the watermark less a small overlap, oldest change first, a page at a
// time. The first page carries the last ETag: when nothing changed GitHub answers 304, which costs nothing. Pull
// requests (the issues API lists them too) are skipped. Any page that fails makes the whole read "unavailable": no
// item is added and the watermark stays where it was.
import { type Gh, realGh } from "../engine/staging.ts";
import type { GithubSource, SourceState } from "./config.ts";

/** Refetched behind the watermark: an issue edited in the same second as the last one seen is not lost. */
export const GITHUB_OVERLAP_MS = 5 * 60 * 1000;
const PER_PAGE = 100;
const MAX_PAGES = 10;

/** What a source read brings: items in the source's own words, keyed `source:native_id`. */
export type RawItem = {
  key: string;
  text: string;
  /** What the content hash covers: an edit to it is a new sighting. */
  hashText: string;
  at: string;
  url?: string;
  by?: string;
  /** The native reference ("#17", the Slack ts) and the chip ("GitHub #17"). */
  ref: string;
  label: string;
};
export type ReadResult = { ok: true; items: RawItem[]; state: Partial<SourceState>; note?: string } | { ok: false; error: string };

type Issue = {
  number: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  updated_at?: string;
  created_at?: string;
  user?: { login?: string };
  pull_request?: unknown;
};

/** Pure: `gh api -i` output split into the HTTP status, the headers (lower-case names) and the body. */
export function splitResponse(out: string): { status: number | null; headers: Record<string, string>; body: string } {
  const m = /^HTTP\/[\d.]+\s+(\d{3})[^\n]*\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(out.replace(/^\s+/, ""));
  if (!m) return { status: null, headers: {}, body: out };
  const headers: Record<string, string> = {};
  for (const l of m[2].split(/\r?\n/)) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { status: Number(m[1]), headers, body: m[3] };
}

/** Pure: the request for one page. */
export function issuesPath(s: Pick<GithubSource, "repo" | "label">, since: string | undefined, page: number): string {
  const q = new URLSearchParams({ labels: s.label, state: "open", sort: "updated", direction: "asc", per_page: String(PER_PAGE), page: String(page) });
  if (since) q.set("since", since);
  return `repos/${s.repo}/issues?${q.toString()}`;
}

/** Pure: an issue as an inbox item. */
export function issueItem(s: Pick<GithubSource, "repo">, i: Issue): RawItem {
  const text = `${(i.title ?? "").trim()}\n\n${(i.body ?? "").trim()}`.trim();
  return {
    key: `github:${s.repo}#${i.number}`,
    text,
    hashText: text,
    at: i.updated_at ?? i.created_at ?? new Date().toISOString(),
    url: i.html_url,
    by: i.user?.login,
    ref: `#${i.number}`,
    label: `GitHub #${i.number}`,
  };
}

export async function readGithub(s: GithubSource, st: SourceState, o: { gh?: Gh; cwd: string }): Promise<ReadResult> {
  const gh = o.gh ?? realGh;
  const since = st.watermark ? new Date(Date.parse(st.watermark) - GITHUB_OVERLAP_MS).toISOString() : undefined;
  const items: RawItem[] = [];
  let watermark = st.watermark;
  let etag: string | undefined;
  const first = issuesPath(s, since, 1);
  for (let page = 1; page <= MAX_PAGES; page++) {
    const p = page === 1 ? first : issuesPath(s, since, page);
    const cond = page === 1 && st.etag && st.etagUrl === first ? ["-H", `If-None-Match: ${st.etag}`] : [];
    const r = await gh(["api", "-i", ...cond, p], o.cwd);
    const res = splitResponse(r.stdout);
    if (res.status === 304) return { ok: true, items: [], state: {}, note: "not modified (304)" };
    if (res.status === null || res.status >= 400 || (r.code && res.status !== 200))
      return { ok: false, error: `gh api ${p}: ${res.status ?? "no answer"} ${(r.stderr || res.body).trim().split("\n").pop()?.slice(0, 200) ?? ""}`.trim() };
    let issues: Issue[];
    try {
      issues = JSON.parse(res.body) as Issue[];
      if (!Array.isArray(issues)) throw new Error("not a list");
    } catch (e) {
      return { ok: false, error: `gh api ${p}: the answer isn't a list of issues (${(e as Error).message})` };
    }
    if (page === 1) etag = res.headers.etag;
    for (const i of issues) {
      if (i.updated_at && (!watermark || i.updated_at > watermark)) watermark = i.updated_at;
      if (i.pull_request) continue;
      items.push(issueItem(s, i));
    }
    if (issues.length < PER_PAGE) return { ok: true, items, state: { watermark, ...(etag ? { etag, etagUrl: first } : {}) } };
  }
  return { ok: false, error: `more than ${MAX_PAGES * PER_PAGE} issues changed since the last collect: read them in a narrower label` };
}
