import fs from "node:fs";
import path from "node:path";

const W = path.resolve(import.meta.dirname, "..", "..");
const L = await import(`${W}/src/checks/spec-lint.ts`);
const { parseProof } = await import(`${W}/src/proof/proof-line.ts`);
const roots = process.argv.slice(2);
for (const root of roots) {
  for (const r of fs.readdirSync(path.join(root, "repos"))) {
    const jobs = path.join(root, "repos", r, ".kitchen", "jobs");
    if (!fs.existsSync(jobs)) continue;
    for (const j of fs.readdirSync(jobs)) {
      const d = path.join(jobs, j);
      const job = JSON.parse(fs.readFileSync(path.join(d, "job.json"), "utf8"));
      if (!/spec-lint|cli/.test(job.pausedReason ?? "")) continue;
      const intake = fs.readFileSync(path.join(d, "intake.md"), "utf8");
      const file = fs.existsSync(path.join(d, "spec.md")) ? path.join(d, "spec.md") : path.join(d, "intake.md");
      const md = fs.readFileSync(file, "utf8");
      const reqs = L.parseRequirements(intake);
      console.log(`== ${r} (${path.basename(file)}) ${job.kind}: ${String(job.pausedReason).slice(0, 90)}`);
      for (const c of L.parseCriteria(md)) {
        if (!c.expect || c.expect === "judged") continue;
        try {
          const b = L.negativeBacking(c.expect, parseProof(c.proof), { kind: job.kind });
          if (b.refuse || b.base.length) console.log(`   ${c.id}: refuse=${b.refuse ?? ""} base=${JSON.stringify(b.base)}`);
        } catch (e) {
          console.log(`   ${c.id}: ${(e as Error).message}`);
        }
      }
      for (const p of L.coverageProblems(L.parseCriteria(md), reqs)) console.log(`   rule7: ${p.slice(0, 120)}`);
    }
  }
}
