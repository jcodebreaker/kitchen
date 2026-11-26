// check-limit (a check): QA drives staging as it is and finds the rule holds; nothing is built or merged.
import fs from "node:fs";
import path from "node:path";
import { done, expect, job, lanesRun } from "./_lib.mjs";

/** The findings QA wrote in the check's last round (title + the criterion it names, if any). */
function findingsOf(j) {
  const f = path.join(path.dirname(process.env.BENCH_JOB), "rounds", String(j.round || 1), "qa", "verdict.json");
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")).findings ?? [];
  } catch {
    return [];
  }
}

const j = job();
if (expect(j, "the check was never filed")) {
  const c = j.check ?? {};
  console.log(`stage ${j.stage}, kind ${j.kind}, check ${JSON.stringify({ result: c.result, pass: c.pass, total: c.total, findings: c.findings })}`);
  expect(j.stage === "done", `stage is ${j.stage}, want done`);
  expect(j.kind === "check", `kind is ${j.kind}, want check`);
  expect(c.total > 0 && c.pass === c.total, `${c.pass} of ${c.total} criteria passed, want all`);
  // The rule holds when no finding names one of its criteria. A finding beside them (staging may still carry a
  // planted bug another ticket fixes later in the run) is QA reporting what it saw, not the check failing.
  const onRule = findingsOf(j).filter((f) => f.criterion || f.criteria?.length);
  expect(!onRule.length, `${onRule.length} problem(s) found on the rule itself: ${onRule.map((f) => f.title).join("; ")}`);
  expect(!lanesRun(j).includes("build"), "a check was built");
  expect(!j.merged, "a check was merged");
}
done();
