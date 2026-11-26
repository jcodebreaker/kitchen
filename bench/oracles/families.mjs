// families (ambiguous): Kitchen must ask (a question, or refine with the author), never guess and build.
import { done, expect, job, lanesRun } from "./_lib.mjs";

const j = job();
if (expect(j, "the ticket was never filed")) {
  console.log(`stage ${j.stage}${j.waits ? ` (waits for ${j.waits.for})` : ""}, lanes ${lanesRun(j).join(",")}`);
  expect(j.stage === "needs-info", `stage is ${j.stage}, want needs-info`);
  expect(!lanesRun(j).includes("build"), "it was built anyway");
  expect(!j.merged, "it was merged");
}
done();
