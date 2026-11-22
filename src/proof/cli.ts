#!/usr/bin/env node
// Spike entry for W0 (the real `kitchen` CLI lands in src/cli/):
//   node src/proof/cli.ts drive <features/x.md> --id x --src dir --evidence dir [--name d] [--arg k=v]… [--toolkit bin] [--sha s] [--round n] [--criterion C]
//   node src/proof/cli.ts verify --evidence dir
//   node src/proof/cli.ts slot acquire --id x [--pid n] [--toolkit bin] | slot release --id x | slot list
// Prints one JSON line on stdout; progress on stderr.
import path from "node:path";
import { execa } from "execa";
import { acquireSlot, listSlots, releaseSlot } from "../toolkit/slots.ts";
import { runDrive } from "./drive.ts";
import { ManifestTampered, recordedHash, verifyManifest } from "./manifest.ts";

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
const defaultToolkit = (src: string) => path.join(src, ".kitchen/toolkit/bin/dev");

async function gitSha(src: string): Promise<string> {
  const r = await execa("git", ["-C", src, "rev-parse", "HEAD"], { reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : "unknown";
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (cmd === "drive") {
    const { flags, multi } = parse(rest);
    const src = path.resolve(need(flags, "src"));
    const args = Object.fromEntries(
      multi.arg.map((kv) => {
        const i = kv.indexOf("=");
        if (i < 1) throw new Error(`--arg takes name=value, got ${kv}`);
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    const r = await runDrive({
      featureFile: path.resolve(sub),
      driveName: flags.name,
      id: need(flags, "id"),
      src,
      evidence: path.resolve(need(flags, "evidence")),
      toolkitBin: path.resolve(flags.toolkit ?? defaultToolkit(src)),
      args,
      sha: flags.sha ?? (await gitSha(src)),
      round: Number(flags.round ?? 1),
      criterion: flags.criterion ?? "-",
      log: (m) => console.error(`[drive] ${m}`),
    });
    const { steps, ...summary } = r;
    return print({ ...summary, steps: steps.length, manifestHash: recordedHash(path.resolve(flags.evidence)) }, r.ok ? 0 : 1);
  }
  if (cmd === "verify") {
    const { flags } = parse([sub, ...rest].filter((x) => x !== undefined));
    try {
      const entries = verifyManifest(path.resolve(need(flags, "evidence")));
      return print({ ok: true, entries: entries.length });
    } catch (e) {
      if (e instanceof ManifestTampered) return print({ ok: false, refused: e.message }, 1);
      throw e;
    }
  }
  if (cmd === "slot") {
    const { flags } = parse(rest);
    if (sub === "acquire") {
      const toolkit = flags.toolkit;
      const r = await acquireSlot({
        id: need(flags, "id"),
        pid: Number(flags.pid ?? process.ppid),
        onStale: async (s) => {
          if (!toolkit) return;
          console.error(`[slot] reclaiming stale slot ${s.n} (${s.id}, pid ${s.pid} gone): down first`);
          await execa(toolkit, ["down", "--id", s.id], { reject: false, stdio: ["ignore", "ignore", "inherit"] });
        },
      });
      return print({ ok: true, slot: r.slot, reclaimed: r.reclaimed.map((s) => s.id) });
    }
    if (sub === "release") return print({ ok: true, released: await releaseSlot(need(flags, "id")) });
    if (sub === "list") return print({ ok: true, slots: listSlots() });
  }
  print({ ok: false, why: `usage: drive|verify|slot (got ${cmd ?? "nothing"})` }, 2);
}

main().catch((e) => print({ ok: false, why: (e as Error).message }, 1));
