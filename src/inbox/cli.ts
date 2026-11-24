// The outer loop's commands (ADR 0022): `kitchen inbox …`, `kitchen collect …`, `kitchen sources …`. Thin: each
// parses its flags and calls the same function the dashboard calls.
import fs from "node:fs";
import path from "node:path";
import {
  BUILTIN,
  configPath,
  defaultName,
  describe,
  GITHUB_REPO,
  listSources,
  readState,
  removeSource,
  SLACK_CHANNEL,
  type SourceConfig,
  saveSource,
} from "../sources/config.ts";
import { storeSlackToken } from "../sources/secret.ts";
import { collect, detachCollect, readSource } from "./collect.ts";
import { installSchedule, keep, parseEvery, removeSchedule } from "./schedule.ts";
import * as inbox from "./store.ts";

type Out = (l: string) => void;
export type Flags = { pos: string[]; flags: Set<string>; vals: Record<string, string[]> };
const one = (f: Flags, k: string) => f.vals[k]?.[0];
const many = (f: Flags, k: string) => f.vals[k] ?? [];

/** The valued flags these commands take (cli.ts parses them). */
export const INBOX_FLAGS = [
  "title",
  "text",
  "item",
  "kind",
  "prio",
  "why",
  "risk",
  "line",
  "step",
  "evidence",
  "sha",
  "cap",
  "of",
  "reason",
  "question",
  "source",
  "link",
  "by",
  "key",
  "label",
  "emoji",
  "channel-name",
  "every",
];

export const MANIFEST = path.resolve(import.meta.dirname, "..", "..", "slack-app-manifest.json");

const age = (iso?: string) => {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

export async function inboxVerb(repo: string, f: Flags, json: boolean, out: Out): Promise<number> {
  const [verb, ...ids] = f.pos;
  const say = (p: inbox.Proposal, what: string) => out(json ? JSON.stringify(p, null, 2) : `${p.id}  ${what}: ${p.title}`);
  switch (verb) {
    case "list": {
      const items = inbox.listItems(repo);
      const props = inbox.listProposals(repo);
      const fresh = inbox.untriaged(repo, items, props);
      if (json) {
        out(JSON.stringify({ items, proposals: props, untriaged: fresh.map((i) => i.id) }, null, 2));
        return 0;
      }
      if (!items.length) out("The inbox is empty. kitchen collect reads your sources (kitchen sources list).");
      for (const p of props.filter((x) => x.state !== "removed"))
        out(
          `${p.id.padEnd(4)} ${p.state.padEnd(6)} ${(p.verdict === "propose" ? (p.prio ?? "--") : p.verdict).padEnd(9)} ${p.title.slice(0, 60)}  [${p.items.join(", ")}]${p.job ? ` → ${p.job}` : ""}`,
        );
      for (const i of fresh) out(`${i.id.padEnd(5)} untriaged  ${i.src.label}: ${i.text.split("\n")[0].slice(0, 70)}`);
      return 0;
    }
    case "add": {
      const text = ids.join(" ");
      const src = one(f, "source") ?? "manual";
      const [r] = await inbox.addItems(repo, [
        {
          key: one(f, "key") ?? `${src}:${Date.now()}`,
          text,
          src: {
            source: src,
            kind: src === BUILTIN ? "kitchen" : (listSources(repo).sources.find((s) => s.name === src)?.kind ?? "manual"),
            label: one(f, "label") ?? (src === "manual" ? "Added by hand" : src),
            ref: one(f, "key") ?? "",
            ...(one(f, "by") ? { by: one(f, "by") } : {}),
            ...(one(f, "link") ? { url: one(f, "link") } : {}),
          },
        },
      ]);
      out(
        r.added === "seen"
          ? `${r.item.id}  already in the inbox (same key and text)`
          : `${r.item.id}  added${r.added === "sighting" ? " (a new sighting: the text changed)" : ""}`,
      );
      return 0;
    }
    case "propose": {
      const p = await inbox.propose(repo, {
        title: one(f, "title") ?? "",
        text: one(f, "text") ?? "",
        items: [...many(f, "item"), ...ids],
        kind: one(f, "kind") ?? "",
        prio: (one(f, "prio") ?? "").toUpperCase(),
        why: one(f, "why") ?? "",
        risk: one(f, "risk"),
        line: one(f, "line"),
        steps: many(f, "step"),
        evidence: many(f, "evidence"),
        sha: one(f, "sha"),
        cap: one(f, "cap"),
      });
      say(p, `proposed ${p.prio}`);
      return 0;
    }
    case "verdict": {
      const v = ids.at(-1) ?? "";
      const p = await inbox.verdict(repo, [...ids.slice(0, -1), ...many(f, "item")], {
        verdict: v,
        reason: one(f, "reason"),
        of: one(f, "of"),
        title: one(f, "title"),
        questions: many(f, "question"),
      });
      say(p, p.state === "aside" ? `set aside (${p.verdict})` : p.verdict === "unclear" ? "unclear: refine it with the person" : "proposed");
      return 0;
    }
    case "hold":
      say(await inbox.hold(repo, need1(ids, "hold")), "held");
      return 0;
    case "bring-back":
      say(await inbox.bringBack(repo, need1(ids, "bring-back")), "back");
      return 0;
    case "remove":
      say(await inbox.remove(repo, need1(ids, "remove")), "removed (kitchen inbox bring-back undoes it)");
      return 0;
    case "edit":
      say(await inbox.edit(repo, need1(ids, "edit"), { title: one(f, "title"), text: one(f, "text") }), "edited");
      return 0;
    case "run": {
      const made = await inbox.run(repo, ids);
      if (json) out(JSON.stringify(made, null, 2));
      else for (const m of made) out(`${m.proposal} → ${m.job}  → intake`);
      return 0;
    }
    default:
      throw new Error(`kitchen inbox: list, add, propose, verdict, hold, bring-back, remove, edit or run (got ${verb ?? "nothing"})`);
  }
}

function need1(ids: string[], verb: string): string {
  if (!ids[0]) throw new Error(`kitchen inbox ${verb} needs a proposal id (p1…)`);
  return ids[0];
}

export async function collectVerb(repo: string, f: Flags, cli: string, out: Out): Promise<number> {
  if (f.flags.has("--remove-schedule")) {
    for (const l of removeSchedule(repo)) out(l);
    keep(repo, { name: "collect" }, null);
    return 0;
  }
  if (f.flags.has("--install-schedule")) {
    const every = parseEvery(one(f, "every") ?? "1h");
    for (const l of installSchedule(repo, cli, every)) out(l);
    keep(repo, { name: "collect" }, every);
    return 0;
  }
  if (f.flags.has("--detach")) return detachCollect(repo, cli, out, f.flags.has("--no-triage") ? ["--no-triage"] : []);
  return collect(repo, out, f.flags.has("--no-triage") ? { triage: null } : {});
}

export const SLACK_SETUP = (channel: string) => [
  "Slack setup (once per workspace; Kitchen reads with your own internal app, which keeps Slack's normal rate limits):",
  `  1. Open https://api.slack.com/apps?new_app=1, choose "From an app manifest", pick your workspace, and paste ${MANIFEST}`,
  "  2. Create, then Install to Workspace (an admin may need to approve it). It can read the channels it is invited to; it never posts.",
  "  3. Copy the Bot User OAuth Token (xoxb-…) from OAuth & Permissions, then run: kitchen sources slack-token  (it reads the token and keeps it in your keychain)",
  `  4. In Slack, invite the app to the channel: /invite @Kitchen in ${channel}`,
  "  5. Mark a message with the emoji to send its thread to Kitchen; kitchen collect reads it.",
];

/** Pure: a source from `kitchen sources add|try <kind> <what> [--label] [--emoji] [--channel-name] [--name]`. */
export function sourceFromFlags(f: Flags): SourceConfig {
  const [, kind, what] = f.pos;
  if (kind === "github") {
    if (!what || !GITHUB_REPO.test(what)) throw new Error("kitchen sources add github <owner/repo> [--label kitchen] [--name <name>]");
    const s = { kind: "github" as const, repo: what, label: one(f, "label") ?? "kitchen" };
    return { ...s, name: one(f, "name") ?? defaultName(s) };
  }
  if (kind === "slack") {
    if (!what || !SLACK_CHANNEL.test(what))
      throw new Error(
        "kitchen sources add slack <channel id, C0123ABCD: in Slack, the channel's name → About → Channel ID> [--channel-name '#bugs'] [--emoji kitchen] [--name <name>]",
      );
    const cn = one(f, "channel-name");
    const s = {
      kind: "slack" as const,
      channel: what,
      ...(cn ? { channelName: cn.replace(/^#?/, "#") } : {}),
      emoji: (one(f, "emoji") ?? "kitchen").replace(/^:|:$/g, ""),
    };
    return { ...s, name: one(f, "name") ?? defaultName(s) };
  }
  throw new Error("kitchen sources add github <owner/repo> | slack <channel id>");
}

export async function sourcesVerb(repo: string, f: Flags, json: boolean, out: Out): Promise<number> {
  const [verb] = f.pos;
  if (verb === undefined || verb === "list") {
    const { sources, bad } = listSources(repo);
    const rows = [
      ...sources.map((s) => ({ name: s.name, kind: s.kind, ...describe(s), config: configPath(s.name), state: readState(repo, s.name) })),
      { name: BUILTIN, kind: "kitchen", ...describe({ kind: "kitchen", name: BUILTIN }), config: null, state: readState(repo, BUILTIN) },
    ];
    if (json) {
      out(JSON.stringify({ sources: rows, unreadable: bad }, null, 2));
      return 0;
    }
    for (const r of rows)
      out(
        `${r.name.padEnd(18)} ${r.label.padEnd(28)} ${r.state.status === "unavailable" ? `unavailable: ${r.state.error}` : `collected ${age(r.state.lastAt)}${r.state.lastAt ? ` · ${r.state.lastNew ? `${r.state.lastNew} new` : "nothing new"}` : ""}`}`,
      );
    for (const b of bad) out(`unreadable: .kitchen/sources/${b}`);
    if (!sources.length) out("No sources yet: in Claude Code, /kitchen sources; or kitchen sources add github <owner/repo> | slack <channel id>");
    return 0;
  }
  if (verb === "add" || verb === "try") {
    const s = sourceFromFlags(f);
    if (verb === "try") {
      const r = await readSource(repo, s, {});
      if (!r.ok) {
        out(`couldn't read ${describe(s).label}: ${r.error}`);
        if (s.kind === "slack") for (const l of SLACK_SETUP(s.channelName ?? s.channel)) out(l);
        return 1;
      }
      out(`${describe(s).label}: ${r.items.length} item${r.items.length === 1 ? "" : "s"} now (nothing saved)`);
      for (const i of r.items.slice(-5)) out(`  ${i.label}${i.by ? ` · ${i.by}` : ""}: ${i.text.split("\n")[0].slice(0, 90)}`);
      return 0;
    }
    if (listSources(repo).sources.some((x) => x.name === s.name) && !f.flags.has("--replace"))
      throw new Error(`a source named ${s.name} exists: --name <another> or --replace`);
    saveSource(repo, s);
    out(`saved ${configPath(s.name)}: ${describe(s).reads}. kitchen collect reads it from now on.`);
    if (s.kind === "slack") for (const l of SLACK_SETUP(s.channelName ?? s.channel)) out(l);
    return 0;
  }
  if (verb === "remove") {
    const name = f.pos[1];
    if (!name) throw new Error("kitchen sources remove <name>");
    out(removeSource(repo, name) ? `removed ${configPath(name)} (its items stay in the inbox)` : `no source ${name}`);
    return 0;
  }
  if (verb === "slack-token") {
    const token = await readSecret("Slack bot token (xoxb-…): ");
    out(`kept in ${storeSlackToken(token)}`);
    return 0;
  }
  throw new Error(`kitchen sources: list, add, try, remove or slack-token (got ${verb})`);
}

/** A line from stdin without echoing it on a terminal; piped input is read whole. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8").trim();
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const s = process.stdin;
    s.setRawMode(true);
    s.resume();
    let v = "";
    const on = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          s.setRawMode(false);
          s.pause();
          s.off("data", on);
          process.stdout.write("\n");
          resolve(v.trim());
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") v = v.slice(0, -1);
        else v += ch;
      }
    };
    s.on("data", on);
  });
}
