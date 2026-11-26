// check-limit (a check): QA drives staging as it is and finds the rule holds; nothing is built or merged.
import { done, expect, job, lanesRun } from "./_lib.mjs";

const j = job();
if (expect(j, "the check was never filed")) {
  const c = j.check ?? {};
  console.log(`stage ${j.stage}, kind ${j.kind}, check ${JSON.stringify({ result: c.result, pass: c.pass, total: c.total, findings: c.findings })}`);
  expect(j.stage === "done", `stage is ${j.stage}, want done`);
  expect(j.kind === "check", `kind is ${j.kind}, want check`);
  expect(c.total > 0 && c.pass === c.total, `${c.pass} of ${c.total} criteria passed, want all`);
  expect(!c.findings, `${c.findings} problems found on a rule that holds`);
  expect(!lanesRun(j).includes("build"), "a check was built");
  expect(!j.merged, "a check was merged");
}
done();
