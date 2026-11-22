// `kitchen retro` (src/retro/retro.ts) by hand:
//   kitchen retro                          run it now (kitchen run starts it every retro.every_jobs finished jobs)
//   kitchen retro status                   mutes, filed lesson drafts, when it is due
//   kitchen retro unmute <lens>/<category> a muted category blocks again
//   kitchen retro approve <n>              a prompt-source draft (.kitchen/retro/drafts/<n>-…) becomes a ticket
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { takeTicket } from "../engine/base.ts";
import { adapterFor } from "../engine/runner.ts";
import { forgeFor } from "../forge/forge.ts";
import { readRetroState, retroDue, runRetro, unmute } from "../retro/retro.ts";
import { GithubSource } from "../sources/github.ts";
import { draftsDir, PromptSource } from "../sources/prompt.ts";
import type { Out } from "./commands.ts";

export async function retro(repo: string, args: string[], out: Out): Promise<number> {
  const [sub, arg] = args;
  const cfg = loadConfig(repo);
  if (!sub) {
    const r = await runRetro({
      repo,
      agent: await adapterFor(repo, cfg),
      forge: forgeFor(repo, cfg),
      source: cfg.source.kind === "github" ? new GithubSource(cfg) : new PromptSource(repo),
      print: out,
    });
    return r.refused.length && !r.filed.length ? 1 : 0;
  }
  if (sub === "status") {
    const st = readRetroState(repo);
    const due = retroDue(repo, cfg);
    out(`retro: ${st.runs} run(s); ${due.finished - due.since} of ${cfg.retro.every_jobs} finished jobs since the last one${due.due ? " (due)" : ""}`);
    out(st.mutes.length ? "muted:" : "muted: none");
    for (const m of st.mutes)
      out(`  ${m.lens}/${m.category}  since ${m.at.slice(0, 10)}, ${m.dismissals} dismissals  (kitchen retro unmute ${m.lens}/${m.category})`);
    out(st.filed.length ? "lesson drafts:" : "lesson drafts: none");
    for (const f of st.filed) out(`  ${f.ref.padEnd(10)} ${f.kind.padEnd(12)} ${f.title}  (${f.signal})`);
    return 0;
  }
  if (sub === "unmute") {
    if (!arg?.includes("/")) throw new Error("kitchen retro unmute <lens>/<category>, as `kitchen retro status` lists it");
    out(unmute(repo, arg));
    return 0;
  }
  if (sub === "approve") {
    if (cfg.source.kind !== "prompt") throw new Error("lesson drafts on GitHub are issues: approve one by adding the source label to it");
    const n = (arg ?? "").padStart(3, "0");
    const d = draftsDir(repo);
    const f = fs.existsSync(d) ? fs.readdirSync(d).find((x) => x.startsWith(`${n}-`) && x.endsWith(".md")) : undefined;
    if (!f) throw new Error(`no lesson draft ${arg} in ${d}`);
    const text = fs
      .readFileSync(path.join(d, f), "utf8")
      .replace(/^<!--.*?-->\n/, "")
      .replace(/^# /, "");
    const { job } = await takeTicket(repo, cfg, PromptSource.ticket(text));
    fs.renameSync(path.join(d, f), path.join(d, f.replace(/\.md$/, ".approved")));
    out(`ticket ${job.id}  "${job.title}"  → intake (from lesson draft ${n})`);
    return 0;
  }
  throw new Error("usage: kitchen retro [status | unmute <lens>/<category> | approve <n>]");
}
