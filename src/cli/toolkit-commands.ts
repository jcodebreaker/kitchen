// W2 commands (PLAN §4): `kitchen toolkit check`, `kitchen init`, and the setup
// role's bridge `kitchen setup-mcp`. Registered from src/cli.ts with one line, so
// they parse their own flags (`--k v` or `--k=v`; a flag given twice is refused).

import { randomBytes } from "node:crypto";
import path from "node:path";
import { plainCheckout } from "../engine/git.ts";
import { serveSetupBridge } from "../init/bridge.ts";
import { initCmd } from "../init/init.ts";
import { detachInit, readStatus, statusReport, tracked } from "../init/status.ts";
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
    const { flags } = parseFlags(argv, ["repo", "answers", "tool", "model", "effort", "max-fix"]);
    for (const k of Object.keys(flags))
      if (!["repo", "answers", "tool", "model", "effort", "max-fix", "generate-only", "detach", "status"].includes(k))
        throw new Error(`kitchen init: unknown flag --${k}`);
    const repo = plainCheckout(path.resolve(str(flags.repo) ?? process.cwd())).workTree;
    if (flags.status === true) {
      const s = readStatus(repo);
      const r = statusReport(s, !!s && ownerAlive({ pid: s.pid, start: s.pidStart }));
      for (const l of r.lines) out(l);
      return r.code;
    }
    if (flags.detach === true) {
      const fixed = argv.map((a) => (a.startsWith("--answers=") ? `--answers=${path.resolve(a.slice(10))}` : a));
      const i = fixed.indexOf("--answers");
      if (i >= 0 && fixed[i + 1]) fixed[i + 1] = path.resolve(fixed[i + 1]);
      return detachInit(repo, CLI, fixed, out);
    }
    return tracked(
      repo,
      (o) =>
        initCmd(
          {
            repo,
            answers: str(flags.answers),
            tool: str(flags.tool) as "claude" | "codex" | undefined,
            model: str(flags.model),
            effort: str(flags.effort),
            maxFix: flags["max-fix"] ? Number(flags["max-fix"]) : undefined,
            generateOnly: flags["generate-only"] === true,
          },
          o,
        ),
      out,
      process.env.KITCHEN_INIT_LOG,
    );
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
  if (pos[0] !== "check") {
    console.error(
      "usage: kitchen toolkit check [--feature <drive|feature>] [--src <worktree>] | up [--rev <ref>] [--src <dir>] | down --id <id>   (maintain comes later)",
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
