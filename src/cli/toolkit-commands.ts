// W2 commands (PLAN §4): `kitchen init` (quick, ADR 0010), `kitchen toolkit build`
// and `toolkit check`, and the setup role's bridge `kitchen setup-mcp`. Registered from src/cli.ts with one line, so
// they parse their own flags (`--k v` or `--k=v`; a flag given twice is refused).

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { plainCheckout } from "../engine/git.ts";
import { MAX_MESSAGE } from "../engine/messages.ts";
import { writeAtomic } from "../engine/store.ts";
import { forgeFor } from "../forge/forge.ts";
import { type Ask, askFor, Halt } from "../init/ask.ts";
import { serveSetupBridge } from "../init/bridge.ts";
import { type Question, questionsFile, toolkitBuild } from "../init/build.ts";
import { installSkill, toolFor } from "../init/files.ts";
import { StatusLine } from "../init/heartbeat.ts";
import { type Agent, preflight, preflightLines } from "../init/preflight.ts";
import { checksRecord, INIT_STEPS, quickInit, readQuickRecord } from "../init/quick.ts";
import { markStep, readResume, saveAnswer, startOver, stoppedAt } from "../init/resume.ts";
import { detachInit, initLog, readStatus, statusReport, tracked } from "../init/status.ts";
import { ownerAlive } from "../lock.ts";

const CLI = path.resolve(import.meta.dirname, "..", `cli${path.extname(import.meta.filename)}`);

import { checkAtRef } from "../toolkit/check.ts";
import { ensurePrepared, toolkitCheckout } from "../toolkit/checkout.ts";
import { runToolkit } from "../toolkit/run.ts";
import { acquireSlot, downSlot, listSlots, releaseSlot } from "../toolkit/slots.ts";

export type Flags = { flags: Record<string, string | true>; pos: string[] };

export function parseFlags(argv: string[], valued: string[]): Flags {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let v: string | true = true;
    if (eq > 0) v = a.slice(eq + 1);
    else if (valued.includes(k)) {
      v = argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
    }
    if (k in flags) throw new Error(`--${k} given twice`);
    flags[k] = v;
  }
  return { flags, pos };
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

const BUILD_ONLY = ["answers", "model", "effort", "max-fix", "generate-only", "detach"];
const BUILD_FLAGS = ["repo", "tool", "verbose", "status", "wait", "yes", "start-over", ...BUILD_ONLY];
const INIT_FLAGS = [...BUILD_FLAGS, "skill", "toolkit"];

/** Pure: only an explicit yes is yes; Enter is no (review R8). */
export const terminalAnswer = (a: string): boolean => /^(y|yes)$/i.test(a.trim());

/**
 * The question about checks an agent proposed: `[y/N]`, Enter is no, and --yes never says yes (untrusted text,
 * review R8). Nobody to ask: none, so they are written commented out.
 */
function proposedChecksConfirm(ask: Ask): ((q: string) => Promise<boolean>) | undefined {
  if (!ask.canAnswer) return undefined;
  return async (q) => (await ask.yesNo(q.replace(/\s*\[y\/N\]\s*$/, ""), { recommended: false, untrusted: true })) ?? false;
}

/** `kitchen init` as typed again: the one command that resumes it (ADR 0011). */
export function initCommand(flags: Record<string, string | true>): string {
  const parts = ["kitchen init"];
  if (str(flags.tool)) parts.push(`--tool ${str(flags.tool)}`);
  if (str(flags.repo)) parts.push(`--repo ${str(flags.repo)}`);
  if (flags.toolkit === true) parts.push("--toolkit");
  if (flags.yes === true) parts.push("--yes");
  return parts.join(" ");
}

/**
 * Before quick init writes anything (ADR 0011): the preflight, then the agent tool. A missing required tool stops
 * init with exit 2 and the fix lines; in a terminal the person can fix it and say so, and it is judged by checking
 * again. Returns the tool (undefined: kitchen.yaml's own, not checked) and whether the person was asked for it, or an
 * exit code.
 */
async function beforeInit(
  repo: string,
  flags: Record<string, string | true>,
  ask: Ask,
  out: (l: string) => void,
): Promise<{ tool: Agent | undefined; asked: boolean } | number> {
  const resume = initCommand(flags);
  const flagTool = str(flags.tool) as Agent | undefined;
  if (flagTool && flagTool !== "claude" && flagTool !== "codex") throw new Error("--tool is claude or codex");
  const cfg = fs.existsSync(path.join(repo, "kitchen.yaml")) ? loadConfig(repo) : null;
  const yamlTool = cfg ? (cfg.agent.command?.length || (cfg.agent.tool !== "claude" && cfg.agent.tool !== "codex") ? "other" : cfg.agent.tool) : undefined;
  const tool = flagTool ?? yamlTool;
  for (;;) {
    const p = await preflight({ repo, tool, ghRequired: cfg?.forge.kind === "github" });
    for (const l of preflightLines(p, resume)) out(l);
    if (p.ok) {
      out("");
      if (tool === "other") return { tool: undefined, asked: false };
      if (tool) return { tool, asked: false };
      // Neither --tool nor kitchen.yaml says: the one that is ready, or, with both, the person's choice.
      const saved = readResume(repo).init?.answers.tool as Agent | undefined;
      if (saved && p.ready.includes(saved)) return { tool: saved, asked: false };
      if (p.ready.length === 1) return { tool: p.ready[0], asked: false };
      const rec = toolFor(repo) === "codex" ? 1 : 0;
      markStep(repo, "init", "agent");
      const pick =
        (await ask.choose(
          "Which agent should Kitchen use?",
          [
            { value: "claude", label: "claude  (Claude Code)" },
            { value: "codex", label: "codex   (Codex)" },
          ],
          rec,
        )) ?? (rec ? "codex" : "claude");
      saveAnswer(repo, "init", "tool", pick);
      return { tool: pick as Agent, asked: true };
    }
    // Only a person at a terminal can fix it and come back; --yes and scripts stop here.
    if (ask.yes || !ask.canAnswer) return 2;
    if (!(await ask.yesNo("Fixed it (in another terminal)? Check again", { recommended: true }))) return 2;
    out("");
  }
}

/**
 * A re-run of an init that stopped: say where, and continue there (or start over). `at` is where the LAST run
 * stopped, read before this run recorded anything. `keep`: answers this run already gave, kept over a start over.
 */
async function resumeInit(
  repo: string,
  flags: Record<string, string | true>,
  ask: Ask,
  out: (l: string) => void,
  at: string | null,
  keep: Record<string, string>,
) {
  const own = [checksRecord(repo)];
  const over = () => {
    const moved = startOver(repo, "init", own);
    for (const [k, v] of Object.entries(keep)) saveAnswer(repo, "init", k, v);
    out(moved.length ? `Starting over: ${moved.map((f) => `${f} → ${f}.bak`).join(", ")}` : "Starting over: nothing to move");
  };
  if (flags["start-over"] === true) return over();
  if (!at) return;
  const label = INIT_STEPS[at] ?? at;
  out(`kitchen init stopped last time at: ${label}.`);
  const pick = await ask.choose(
    "Continue there, or start over?",
    [
      { value: "continue", label: `Continue at ${label}, with your answers so far` },
      { value: "over", label: "Start over (the old state goes to .bak)" },
    ],
    0,
  );
  if (pick === "over") over();
  else if (pick === undefined) out(`Continuing at ${label} (kitchen init --start-over begins again).`);
}

/** `--status [--wait <secs>]`: how a detached build is doing; blocks up to `--wait` (at most 110 s, so one agent tool call stays short) while it runs. */
async function buildStatus(repo: string, flags: Record<string, string | true>, out: (l: string) => void, who?: string): Promise<number> {
  // Agent tools may refuse a plain `sleep`; this is the way to wait between polls.
  const wait = Math.min(110, Math.max(0, Number(str(flags.wait) ?? 0) || 0)) * 1000;
  const end = Date.now() + wait;
  const live = () => {
    const s = readStatus(repo);
    return { s, alive: !!s && ownerAlive({ pid: s.pid, start: s.pidStart }) };
  };
  let cur = live();
  while (cur.s?.state === "running" && cur.alive && Date.now() < end) {
    await new Promise((res) => setTimeout(res, 2000));
    cur = live();
  }
  const r = statusReport(cur.s, cur.alive, Date.now(), who);
  for (const l of r.lines) out(l);
  return r.code;
}

/**
 * The Toolkit build, in the foreground (status file kept current, every detail appended to
 * .kitchen/init/init.log, the terminal quiet unless --verbose) or detached (`--detach`: its own
 * process, whose stdout is init.log, so it logs everything there).
 */
async function runBuild(repo: string, flags: Record<string, string | true>, out: (l: string) => void, ask?: Ask): Promise<number> {
  if (flags.detach === true) {
    const args = ["--repo", repo];
    for (const k of ["tool", "model", "effort", "max-fix"]) if (str(flags[k])) args.push(`--${k}`, str(flags[k]) as string);
    if (str(flags.answers)) args.push("--answers", path.resolve(str(flags.answers) as string));
    if (flags["generate-only"] === true) args.push("--generate-only");
    if (flags.yes === true) args.push("--yes");
    if (flags["start-over"] === true) args.push("--start-over");
    return detachInit(repo, CLI, args, out);
  }
  const intoLog = process.env.KITCHEN_INIT_LOG; // a detached child: stdout already is the log
  const verbose = flags.verbose === true || !!intoLog;
  const log = initLog(repo);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const append = (l: string) => {
    if (!intoLog) fs.appendFileSync(log, `${l}\n`);
  };
  // The heartbeat (ADR 0011): one status line rewritten in place on a terminal; without one, a line at most every 10 s.
  const tty = process.stdout.isTTY === true && !intoLog;
  const sl = new StatusLine({
    tty,
    write: (s) => (tty ? process.stdout.write(s) : out(s.replace(/\n$/, ""))),
    cols: process.stdout.columns,
  });
  const timer = setInterval(() => sl.tick(), 1000);
  const resume = ["kitchen toolkit build", ...(str(flags.repo) ? [`--repo ${str(flags.repo)}`] : [])].join(" ");
  try {
    return await tracked(
      repo,
      (tee) =>
        toolkitBuild(
          {
            repo,
            answers: str(flags.answers),
            tool: str(flags.tool) as "claude" | "codex" | undefined,
            model: str(flags.model),
            effort: str(flags.effort),
            maxFix: flags["max-fix"] ? Number(flags["max-fix"]) : undefined,
            generateOnly: flags["generate-only"] === true,
            ask: ask ?? askFor({ yes: flags.yes === true, out: (l) => sl.line(l), tty }),
            startOver: flags["start-over"] === true,
            resume,
          },
          {
            phase: (l) => {
              tee(l);
              append(l);
            },
            log: (l) => {
              append(l);
              if (verbose) tee(l);
            },
            agenda: (l) => {
              sl.restart();
              tee(l);
              append(l);
            },
            beat: (t) => sl.beat(t),
          },
        ),
      (l) => sl.line(l),
      intoLog,
    );
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    sl.line("");
    sl.line(`Stopped. Resume: ${resume}`);
    return 130;
  } finally {
    clearInterval(timer);
    sl.stop();
  }
}

export async function w2(name: string, argv: string[]): Promise<number> {
  const out = (l: string) => console.log(l);
  if (name === "setup-mcp") {
    const { flags } = parseFlags(argv, ["repo", "worktree"]);
    const staticOnly = flags.static === true;
    const repo = str(flags.repo);
    const wt = str(flags.worktree);
    if (!repo || !wt) throw new Error("usage: kitchen setup-mcp --repo <dir> --worktree <setup worktree>");
    await serveSetupBridge({ repo: path.resolve(repo), worktree: path.resolve(wt), staticOnly });
    return 0;
  }
  if (name === "init") {
    const { flags } = parseFlags(argv, ["repo", "answers", "tool", "model", "effort", "max-fix", "wait"]);
    for (const k of Object.keys(flags)) if (!INIT_FLAGS.includes(k)) throw new Error(`kitchen init: unknown flag --${k}`);
    const repo = plainCheckout(path.resolve(str(flags.repo) ?? process.cwd())).workTree;
    // --skill: only the /kitchen skill, so the setup itself can start from inside Claude Code or Codex.
    if (flags.skill === true) {
      for (const f of installSkill(repo)) out(`skill installed: ${f}`);
      out("next: open Claude Code (or Codex) in this repo and type: /kitchen set up Kitchen");
      return 0;
    }
    // `init --status`: the build's status in the words skills from before ADR 0010 poll for (`init: …`).
    if (flags.status === true) return buildStatus(repo, flags, out, "init");
    if ("wait" in flags) throw new Error("kitchen init: --wait goes with --status");
    // Flags that only mean something for the Toolkit build (the pre-ADR-0010 init's) run the build too.
    const implied = BUILD_ONLY.some((k) => k in flags);
    const toolkit = flags.toolkit === true || implied;
    if (flags.verbose === true && !toolkit) throw new Error("kitchen init: --verbose goes with --toolkit (quick init has nothing more to show)");
    const ask = askFor({ yes: flags.yes === true, out });
    try {
      // An old skill's `init --detach` / `--answers` on a repo quick init already set up: straight to the build, so it returns at once.
      if (!(implied && readQuickRecord(repo))) {
        // Where the last run stopped, read before this run records any step of its own.
        const at = stoppedAt(repo, "init");
        const before = await beforeInit(repo, flags, ask, out);
        if (typeof before === "number") return before;
        const tool = before.tool;
        await resumeInit(repo, flags, ask, out, at, before.asked && tool ? { tool } : {});
        const code = await quickInit({ repo, tool, confirm: proposedChecksConfirm(ask), resume: initCommand(flags) }, out);
        if (!toolkit || code !== 0) return code;
        out("");
      }
      const { "start-over": _, ...buildFlags } = flags; // init's --start-over was init's own
      return await runBuild(repo, buildFlags, out, ask);
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
      out("");
      out(`Stopped. Resume: ${initCommand(flags)}`);
      return 130;
    }
  }
  if (name === "toolkit" && argv[0] === "build") {
    const { flags, pos } = parseFlags(argv.slice(1), ["repo", "answers", "tool", "model", "effort", "max-fix", "wait"]);
    for (const k of Object.keys(flags)) if (!BUILD_FLAGS.includes(k)) throw new Error(`kitchen toolkit build: unknown flag --${k}`);
    if (pos.length) throw new Error(`kitchen toolkit build: unexpected ${pos[0]}`);
    const repo = plainCheckout(path.resolve(str(flags.repo) ?? process.cwd())).workTree;
    if (flags.status === true) return buildStatus(repo, flags, out);
    return runBuild(repo, flags, out);
  }
  // toolkit check [--feature x] [--src dir] [--rev r] · toolkit up [--rev r] [--src dir] · toolkit down --id <id>
  const { flags, pos } = parseFlags(argv, ["repo", "feature", "src", "rev", "id"]);
  for (const k of Object.keys(flags)) if (!["repo", "feature", "src", "rev", "id"].includes(k)) throw new Error(`kitchen toolkit: unknown flag --${k}`);
  const repo = path.resolve(str(flags.repo) ?? process.cwd());
  if (pos[0] === "up") return toolkitUp(repo, { rev: str(flags.rev), src: str(flags.src) }, out);
  if (pos[0] === "down") {
    const id = str(flags.id);
    if (!id) throw new Error("usage: kitchen toolkit down --id <id>");
    return toolkitDown(id, out);
  }
  if (pos[0] === "maintain") {
    const r = await (await import("../toolkit/maintain.ts")).maintain({
      repo,
      forge: forgeFor(plainCheckout(repo).workTree, loadConfig(plainCheckout(repo).workTree)),
      print: out,
    });
    return r.outcome === "blocked" ? 1 : 0;
  }
  if (pos[0] !== "check") {
    console.error(
      "usage: kitchen toolkit build [--detach] [--status] [--answers <file>] [--verbose] | check [--feature <drive|feature>] [--src <worktree>] | up [--rev <ref>] [--src <dir>] | down --id <id> | maintain",
    );
    return 2;
  }
  const r = await checkAtRef(repo, { rev: str(flags.rev), src: str(flags.src), feature: str(flags.feature), print: out });
  return r.ok ? 0 : 1;
}

/**
 * `kitchen toolkit up`: one instance of the app for a person to look at, from
 * the engine-owned checkout (primitives) and `--src` (default: that checkout),
 * in its own slot. Runs in the foreground: the slot belongs to this process, so
 * Ctrl-C (or the end of the process) brings it down; one killed with -9 is
 * reclaimed like any stale slot, or by `kitchen toolkit down --id <id>`.
 */
async function toolkitUp(repo: string, o: { rev?: string; src?: string }, out: (l: string) => void): Promise<number> {
  repo = plainCheckout(repo).workTree;
  const co = await toolkitCheckout(repo, o.rev ?? "HEAD");
  if (!co.merged)
    out(`toolkit up: ${co.sha.slice(0, 12)} is not merged into the base: bin/dev runs ${co.sandboxed ? "under sandbox-exec" : "UNSANDBOXED"} (ADR 0008)`);
  const src = path.resolve(o.src ?? co.dir);
  let slotId: string | null = null;
  // Ctrl-C from the first moment: a stop that comes during prepare or up still brings the slot down.
  let stopped = false;
  let wake = () => {};
  const stop = () => {
    stopped = true;
    wake();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const down = async () => {
    if (slotId) {
      const id = slotId;
      slotId = null;
      const r = await runToolkit(co.bin, ["down", `--id=${id}`], { src, timeoutMs: 120_000 });
      await releaseSlot(id);
      out(`toolkit down: ${id} ${r.json?.status === "ok" ? "stopped" : `down said ${JSON.stringify(r.json ?? r.stderr.slice(-200))}`}`);
    }
    co.release();
  };
  try {
    const p = await ensurePrepared(repo, co, src);
    out(`toolkit up: prepare ${p.cached ? "cached" : `done in ${Math.round(p.secs)}s`}`);
    const { slot } = await acquireSlot({ id: `dev-${randomBytes(3).toString("hex")}`, toolkitBin: co.bin, src });
    slotId = slot.id;
    const r = await runToolkit(co.bin, ["up", `--id=${slot.id}`, `--src=${src}`, `--ports=${slot.ports.join(",")}`], { src, timeoutMs: 10 * 60_000 });
    if (r.json?.status !== "ready") {
      out(`toolkit up: failed: ${String(r.json?.why ?? r.stderr.trim().split("\n").pop() ?? `exit ${r.exit}`)}`);
      return 1;
    }
    out(`toolkit up: ${slot.id} ready at ${String(r.json.url)} (Toolkit ${co.sha.slice(0, 12)}, source ${src})`);
    out(`toolkit up: Ctrl-C to stop (or: kitchen toolkit down --id ${slot.id})`);
    const alive = setInterval(() => {}, 60_000); // signal handlers don't keep the process up on their own
    if (!stopped) await new Promise<void>((resolve) => (wake = resolve));
    clearInterval(alive);
  } finally {
    await down();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}

/** `kitchen toolkit down --id <id>`: that slot's own Toolkit `down`, then the slot is freed (any repo's slot: the registry is per machine). */
async function toolkitDown(id: string, out: (l: string) => void): Promise<number> {
  const s = listSlots().find((x) => x.id === id);
  if (!s) {
    out(`toolkit down: no slot ${id} (kitchen status lists a job's slot)`);
    return 1;
  }
  await downSlot(s);
  await releaseSlot(id);
  out(`toolkit down: ${id} stopped and its slot freed`);
  return 0;
}

/**
 * The Setup's questions answered from the dashboard: the same as writing the answers file and running
 * `kitchen toolkit build --answers <file> --detach`. Only ids the waiting questions name are taken.
 */
export function answerSetup(repo: string, answers: Record<string, unknown>, out: (l: string) => void, cli = CLI): number {
  const s = readStatus(repo);
  if (s?.state !== "questions") {
    out("toolkit build: no questions are waiting (kitchen toolkit build --status)");
    return 1;
  }
  let qs = s.questions ?? [];
  if (!qs.length)
    try {
      qs = (JSON.parse(fs.readFileSync(questionsFile(repo), "utf8")) as { questions: Question[] }).questions ?? [];
    } catch {}
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (!qs.some((q) => q.id === k)) throw new Error(`no setup question ${k}`);
    if (typeof v !== "string" || v.length > MAX_MESSAGE) throw new Error(`the answer to ${k} must be text of at most ${MAX_MESSAGE} characters`);
    clean[k] = v.trim();
  }
  const file = path.join(repo, ".kitchen", "setup-answers.json");
  writeAtomic(file, `${JSON.stringify({ answers: clean }, null, 2)}\n`);
  return detachInit(repo, cli, ["--answers", file], out);
}
