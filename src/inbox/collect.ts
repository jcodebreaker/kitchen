// `kitchen collect` (ADR 0022 §3 and its amendment): read every source by code, add what is new to the inbox, then
// start one triage session that reads the new items together. One collect at a time per repo: a collect that finds
// another running exits without writing (exit 4). Progress is .kitchen/inbox/collect.json while it runs (the
// dashboard's Collect button reads it, whoever started the collect: the button, the CLI or the schedule).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Gh, realGh } from "../engine/staging.ts";
import { kitchenDir, writeAtomic } from "../engine/store.ts";
import { ownerAlive, processStart, withFileLock } from "../lock.ts";
import { BUILTIN, listSources, readState, type SourceConfig, type SourceState, writeState } from "../sources/config.ts";
import { type ReadResult, readGithub } from "../sources/github.ts";
import { slackToken } from "../sources/secret.ts";
import { readSlack } from "../sources/slack.ts";
import { addItems, inboxDir, type NewItem, untriaged } from "./store.ts";

export type Out = (l: string) => void;
export type Progress = {
  pid: number;
  start: string | null;
  at: string;
  phase: "read" | "triage";
  source: string | null;
  step: number;
  of: number;
  text: string;
  /** Items this collect added, for the Coming-in rows. */
  items: string[];
};

export const collectLock = (repo: string) => path.join(kitchenDir(repo), "collect.lock");
export const progressFile = (repo: string) => path.join(inboxDir(repo), "collect.json");
const lastFile = (repo: string) => path.join(inboxDir(repo), "last-collect.json");
export const collectLog = (repo: string) => path.join(kitchenDir(repo), "collect.log");
/** `kitchen collect` exits with this when another collect holds the lock. */
export const BUSY = 4;

/** The collect running now, or null (a progress file whose process is gone is stale). */
export function liveCollect(repo: string): Progress | null {
  try {
    const p = JSON.parse(fs.readFileSync(progressFile(repo), "utf8")) as Progress;
    return ownerAlive({ pid: p.pid, start: p.start }) ? p : null;
  } catch {
    return null;
  }
}

export function lastCollect(repo: string): { at: string; added: number; proposed?: number; aside?: number } | null {
  try {
    return JSON.parse(fs.readFileSync(lastFile(repo), "utf8"));
  } catch {
    return null;
  }
}

/** How one source is read: by kind. Tests hand in a stand-in `gh` and `fetch`. */
export type Readers = { gh?: Gh; fetch?: typeof fetch; slackToken?: () => string | null };
export async function readSource(repo: string, s: SourceConfig, st: SourceState, r: Readers = {}): Promise<ReadResult> {
  if (s.kind === "github") return readGithub(s, st, { gh: r.gh ?? realGh, cwd: repo });
  return readSlack(s, st, { token: (r.slackToken ?? (() => slackToken()))(), fetch: r.fetch });
}

export type SourceOutcome = { name: string; status: "available" | "unavailable"; added: number; error?: string; note?: string };

/**
 * Read one source and add what is new. A complete read moves the watermark and records the collect; a failed or
 * partial one marks the source unavailable and leaves its watermark (and the inbox) as they were.
 */
export async function collectSource(repo: string, s: SourceConfig, r: Readers = {}, now = new Date()): Promise<SourceOutcome & { ids: string[] }> {
  const st = readState(repo, s.name);
  const res = await readSource(repo, s, st, r);
  if (!res.ok) {
    writeState(repo, s.name, { ...st, triedAt: now.toISOString(), status: "unavailable", error: res.error });
    return { name: s.name, status: "unavailable", added: 0, error: res.error, ids: [] };
  }
  const added = await addItems(
    repo,
    res.items.map(
      (i): NewItem => ({
        key: i.key,
        text: i.text,
        hashText: i.hashText,
        at: i.at,
        src: { source: s.name, kind: s.kind, label: i.label, ref: i.ref, ...(i.by ? { by: i.by } : {}), ...(i.url ? { url: i.url } : {}) },
      }),
    ),
    now,
  );
  const fresh = added.filter((a) => a.added !== "seen").map((a) => a.item.id);
  const next: SourceState = { ...st, ...res.state, lastAt: now.toISOString(), triedAt: now.toISOString(), lastNew: fresh.length, status: "available" };
  delete next.error;
  writeState(repo, s.name, next);
  return { name: s.name, status: "available", added: fresh.length, ids: fresh, ...(res.note ? { note: res.note } : {}) };
}

export type Triage = (repo: string, o: { items: string[]; progress: (text: string) => void }, out: Out) => Promise<number>;

/**
 * `kitchen collect`: under the collect lock, every source in turn, then triage when anything is untriaged (the
 * new items, and any an interrupted collect left). `triage: null` stops after reading (`--no-triage`).
 */
export async function collect(repo: string, out: Out, o: { readers?: Readers; triage?: Triage | null; now?: () => Date } = {}): Promise<number> {
  fs.mkdirSync(inboxDir(repo), { recursive: true });
  const now = o.now ?? (() => new Date());
  try {
    return await withFileLock(
      collectLock(repo),
      async () => {
        const { sources, bad } = listSources(repo);
        for (const b of bad) out(`skipped .kitchen/sources/${b}: not a source Kitchen reads (kitchen sources list)`);
        const me = { pid: process.pid, start: processStart(process.pid) };
        const ids: string[] = [];
        const prog = (p: Partial<Progress>) =>
          writeAtomic(
            progressFile(repo),
            JSON.stringify({ ...me, at: now().toISOString(), phase: "read", source: null, step: 0, of: sources.length, text: "", items: ids, ...p }),
          );
        try {
          const outcomes: SourceOutcome[] = [];
          for (const [k, s] of sources.entries()) {
            prog({ source: s.name, step: k + 1, text: `Collecting · ${k + 1} of ${sources.length} source${sources.length === 1 ? "" : "s"}` });
            const r = await collectSource(repo, s, o.readers, now());
            ids.push(...r.ids);
            outcomes.push(r);
            out(
              r.status === "unavailable"
                ? `${s.name}: unavailable (${r.error}); its watermark stays`
                : `${s.name}: ${r.added ? `${r.added} new` : "nothing new"}${r.note ? ` (${r.note})` : ""}`,
            );
          }
          if (!sources.length)
            out(`no sources yet: in Claude Code, /kitchen sources (or kitchen sources add github|slack); ${BUILTIN} findings come in by themselves`);
          const waiting = untriaged(repo).map((i) => i.id);
          let code = 0;
          if (!waiting.length) out("nothing to triage");
          else if (o.triage === null)
            out(`${waiting.length} item${waiting.length === 1 ? "" : "s"} to triage: kitchen collect (without --no-triage) triages them`);
          else {
            const text = `Triaging ${waiting.length} item${waiting.length === 1 ? "" : "s"}`;
            prog({ phase: "triage", text, items: waiting });
            out(`${text}…`);
            const triage = o.triage ?? (await import("./triage.ts")).triage;
            code = await triage(repo, { items: waiting, progress: (t) => prog({ phase: "triage", text: t, items: waiting }) }, out);
          }
          writeAtomic(lastFile(repo), JSON.stringify({ at: now().toISOString(), added: ids.length, sources: outcomes }));
          return code;
        } finally {
          fs.rmSync(progressFile(repo), { force: true });
        }
      },
      { timeoutMs: 0 },
    );
  } catch (e) {
    if (/^lock .* held by/.test((e as Error).message)) {
      out("a collect is already running in this repo: this one stops without reading anything");
      return BUSY;
    }
    throw e;
  }
}

/** `kitchen collect --detach` (the dashboard's Collect, a schedule): the same, in the background; the log is .kitchen/collect.log. */
export function detachCollect(repo: string, cli: string, out: Out, extra: string[] = []): number {
  fs.mkdirSync(kitchenDir(repo), { recursive: true });
  const fd = fs.openSync(collectLog(repo), "a");
  const child = spawn(process.execPath, [cli, "collect", "--repo", repo, ...extra], { cwd: repo, detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.unref();
  fs.closeSync(fd);
  out(`collect detached: pid ${child.pid}, log ${path.relative(repo, collectLog(repo))}`);
  return 0;
}
