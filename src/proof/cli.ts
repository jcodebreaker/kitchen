#!/usr/bin/env node
// Spike entry for W0 (the real `kitchen` CLI lands in W1). A job dir stands in
// for .kitchen/jobs/<id>/: job.json (with the manifest head) + evidence/.
//   node src/proof/cli.ts toolkit <bin> <src> <command> [args…]   (runs bin/dev as the engine does)
//   node src/proof/cli.ts job create <jobDir> --worktree dir [--repo main --worktree-id id] --toolkit bin --slot-id id [--round n]
//     (--repo/--worktree-id for a linked worktree; without them --worktree must be a plain checkout)
//   node src/proof/cli.ts drive <jobDir> (--feature name [--file f.md] | --primitive p [--pargs json]) [--arg k=v]… [--criterion C] [--role r]
//   node src/proof/cli.ts verify <jobDir>
//   node src/proof/cli.ts slot acquire --id x --toolkit bin --src dir [--pid n] | slot release --id x | slot list
// Prints one JSON line on stdout; progress on stderr.
import path from "node:path";
import { runToolkit } from "../toolkit/run.ts";
import { acquireSlot, downSlot, listSlots, releaseSlot } from "../toolkit/slots.ts";
import { runDrive } from "./drive.ts";
import { createJob, evidenceDir, readJob, sealOf } from "./job.ts";
import { ManifestTampered, verifyManifest } from "./manifest.ts";

function parse(argv: string[]) {
  const flags: Record<string, string> = {};
  const multi: Record<string, string[]> = { arg: [] };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const k = a.slice(2);
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    if (k in multi) multi[k].push(v);
    else if (k in flags) throw new Error(`--${k} given twice`);
    else flags[k] = v;
  }
  return { flags, multi, pos };
}

const print = (o: unknown, code = 0) => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
  process.exitCode = code;
};
const need = (f: Record<string, string>, k: string) => {
  if (!f[k]) throw new Error(`--${k} is required`);
  return f[k];
};

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (cmd === "toolkit") {
    // Any Toolkit command, the way the engine runs it (untrusted env + Docker): toolkit <bin> <src> <command> [args…]
    const [src, ...argv] = rest;
    const r = await runToolkit(path.resolve(sub), argv, { src: path.resolve(src) });
    if (r.stderr) process.stderr.write(r.stderr);
    process.stdout.write(r.stdout.endsWith("\n") || !r.stdout ? r.stdout : `${r.stdout}\n`);
    process.exitCode = r.exit;
    return;
  }
  if (cmd === "job" && sub === "create") {
    const { flags, pos } = parse(rest);
    const job = createJob(
      path.resolve(pos[0]),
      {
        id: path.basename(path.resolve(pos[0])),
        worktree: path.resolve(need(flags, "worktree")),
        toolkitBin: path.resolve(need(flags, "toolkit")),
        slotId: need(flags, "slot-id"),
        round: Number(flags.round ?? 1),
      },
      flags.repo ? { mainRepo: path.resolve(flags.repo), id: need(flags, "worktree-id") } : undefined,
    );
    return print({ ok: true, job });
  }
  if (cmd === "drive") {
    const { flags, multi } = parse(rest);
    const jobDir = path.resolve(sub);
    const args = Object.fromEntries(
      multi.arg.map((kv) => {
        const i = kv.indexOf("=");
        if (i < 1) throw new Error(`--arg takes name=value, got ${kv}`);
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    const request = flags.primitive
      ? { primitive: flags.primitive, args: flags.pargs ? JSON.parse(flags.pargs) : {} }
      : { feature: flags.feature ?? "", file: flags.file ? path.resolve(flags.file) : undefined, args };
    const r = await runDrive({
      jobDir,
      request,
      criterion: flags.criterion ?? "-",
      role: flags.role ?? "engine",
      log: (m) => console.error(`[drive] ${m}`),
    });
    const { steps, ...summary } = r;
    return print({ ...summary, steps: steps.length, evidence: steps.flatMap((s) => s.evidence) }, r.ok ? 0 : 1);
  }
  if (cmd === "verify") {
    const jobDir = path.resolve(sub);
    try {
      const job = readJob(jobDir);
      const entries = verifyManifest(evidenceDir(jobDir), job.manifestHead, sealOf(job));
      return print({ ok: true, entries: entries.length });
    } catch (e) {
      if (e instanceof ManifestTampered) return print({ ok: false, refused: e.message }, 1);
      throw e;
    }
  }
  if (cmd === "slot") {
    const { flags } = parse(rest);
    if (sub === "acquire") {
      const r = await acquireSlot({
        id: need(flags, "id"),
        toolkitBin: path.resolve(need(flags, "toolkit")),
        src: path.resolve(need(flags, "src")),
        pid: Number(flags.pid ?? process.ppid),
        onStale: async (s) => {
          console.error(`[slot] reclaiming stale slot ${s.n} (${s.id}, pid ${s.pid} gone): ${s.toolkitBin} down first`);
          await downSlot(s);
        },
      });
      return print({ ok: true, slot: r.slot, reclaimed: r.reclaimed.map((s) => s.id) });
    }
    if (sub === "release") return print({ ok: true, released: await releaseSlot(need(flags, "id")) });
    if (sub === "list") return print({ ok: true, slots: listSlots() });
  }
  print({ ok: false, why: `usage: job create|drive|verify|slot (got ${cmd ?? "nothing"})` }, 2);
}

main().catch((e) => print({ ok: false, why: (e as Error).message }, 1));
