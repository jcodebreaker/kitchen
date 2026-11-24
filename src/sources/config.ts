// The outer loop's sources (ADR 0022, amendment): where Kitchen's code reads reports from. Each is a config,
// `.kitchen/sources/<name>.json` (`/kitchen sources` writes it after a test read; `kitchen sources add` too), and its
// state, `<name>.state.json`: the watermark (refetched with a small overlap), GitHub's ETag, the last collect, what it
// brought, and whether the source answered ("unavailable" is never "empty"). Only `kitchen collect` writes the state.
// "Kitchen findings" is built in: no config, the lanes add its items as they finish.
import fs from "node:fs";
import path from "node:path";
import { kitchenDir, writeAtomic } from "../engine/store.ts";

export type GithubSource = { kind: "github"; name: string; repo: string; label: string };
export type SlackSource = { kind: "slack"; name: string; channel: string; channelName?: string; emoji: string };
export type SourceConfig = GithubSource | SlackSource;
export type SourceKind = SourceConfig["kind"] | "kitchen" | "manual";

export type SourceState = {
  /** GitHub: the newest `updated_at` seen; Slack: the newest message `ts` seen. Moves only after a complete read. */
  watermark?: string;
  /** GitHub: the ETag of the last 200, and the request it belongs to (a 304 on that request costs nothing). */
  etag?: string;
  etagUrl?: string;
  /** The last complete read, and how many new items it brought. */
  lastAt?: string;
  lastNew?: number;
  /** The last try, complete or not. */
  triedAt?: string;
  status?: "available" | "unavailable";
  error?: string;
  /** Slack: user id → display name, and the workspace URL (for links back). */
  users?: Record<string, string>;
  teamUrl?: string;
};

export const BUILTIN = "kitchen";
export const SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const SLACK_CHANNEL = /^[CG][A-Z0-9]{6,}$/;

export const sourcesDir = (repo: string) => path.join(kitchenDir(repo), "sources");
const configFile = (repo: string, name: string) => path.join(sourcesDir(repo), `${name}.json`);
const stateFile = (repo: string, name: string) => path.join(sourcesDir(repo), `${name}.state.json`);
export const configPath = (name: string) => `.kitchen/sources/${name}.json`;

/** Pure: a config as read from disk, checked; null when it isn't one Kitchen reads. */
export function parseSource(name: string, raw: unknown): SourceConfig | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (r.kind === "github" && typeof r.repo === "string" && GITHUB_REPO.test(r.repo))
    return { kind: "github", name, repo: r.repo, label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : "kitchen" };
  if (r.kind === "slack" && typeof r.channel === "string" && SLACK_CHANNEL.test(r.channel))
    return {
      kind: "slack",
      name,
      channel: r.channel,
      ...(typeof r.channelName === "string" && r.channelName.trim() ? { channelName: r.channelName.trim().replace(/^#?/, "#") } : {}),
      emoji: typeof r.emoji === "string" && r.emoji.trim() ? r.emoji.trim().replace(/^:|:$/g, "") : "kitchen",
    };
  return null;
}

/** Every configured source, by name; a file Kitchen can't read is skipped (`kitchen sources list` names it). */
export function listSources(repo: string): { sources: SourceConfig[]; bad: string[] } {
  const d = sourcesDir(repo);
  if (!fs.existsSync(d)) return { sources: [], bad: [] };
  const sources: SourceConfig[] = [];
  const bad: string[] = [];
  for (const f of fs.readdirSync(d).sort()) {
    if (!f.endsWith(".json") || f.endsWith(".state.json")) continue;
    const name = f.slice(0, -5);
    let s: SourceConfig | null = null;
    try {
      s = SOURCE_NAME.test(name) ? parseSource(name, JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))) : null;
    } catch {}
    if (s) sources.push(s);
    else bad.push(f);
  }
  return { sources, bad };
}

export function readSource(repo: string, name: string): SourceConfig {
  const s = listSources(repo).sources.find((x) => x.name === name);
  if (!s) throw new Error(`no source ${name} (kitchen sources list)`);
  return s;
}

export function saveSource(repo: string, s: SourceConfig) {
  if (!SOURCE_NAME.test(s.name)) throw new Error(`a source name is lowercase letters, digits and dashes (got ${s.name})`);
  if (s.name === BUILTIN) throw new Error(`${BUILTIN} is the built-in source (Kitchen findings): pick another name`);
  const { name: _n, ...body } = s;
  writeAtomic(configFile(repo, s.name), `${JSON.stringify(body, null, 2)}\n`);
}

export function removeSource(repo: string, name: string): boolean {
  const had = fs.existsSync(configFile(repo, name));
  fs.rmSync(configFile(repo, name), { force: true });
  fs.rmSync(stateFile(repo, name), { force: true });
  return had;
}

export function readState(repo: string, name: string): SourceState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(repo, name), "utf8")) as SourceState;
  } catch {
    return {};
  }
}

export function writeState(repo: string, name: string, st: SourceState) {
  writeAtomic(stateFile(repo, name), `${JSON.stringify(st, null, 2)}\n`);
}

/** Pure: a default name for a new source ("github-issues", "slack-bugs"). */
export function defaultName(s: Omit<GithubSource, "name"> | Omit<SlackSource, "name">): string {
  const slug = (x: string) =>
    x
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30);
  return s.kind === "github" ? `github-${slug(s.repo.split("/")[1])}` : `slack-${slug(s.channelName ?? s.channel)}`;
}

/** What the dashboard and `kitchen sources list` say about a source, in plain words. Pure. */
export function describe(s: SourceConfig | { kind: "kitchen"; name: string }): { label: string; reads: string; tool: string; skip: string } {
  if (s.kind === "github")
    return {
      label: `GitHub · ${s.repo}`,
      reads: `Open issues in ${s.repo} labelled “${s.label}”, new or edited since the last collect`,
      tool: "gh, with your login",
      skip: "pull requests, closed issues, issues without the label",
    };
  if (s.kind === "slack")
    return {
      label: `Slack · ${s.channelName ?? s.channel}`,
      reads: `Messages in ${s.channelName ?? s.channel} that carry :${s.emoji}:, with their threads`,
      tool: "your workspace's Kitchen app (its token in the keychain)",
      skip: `messages without :${s.emoji}:`,
    };
  return {
    label: "Kitchen findings",
    reads: "QA notes outside a job's criteria, non-blocking review findings, failed sweep or upkeep recipes",
    tool: "",
    skip: "",
  };
}
