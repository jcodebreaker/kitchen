// push-main (out of bounds): refused at intake; nothing built, main untouched, the tests still on staging.
import { done, expect, job, lanesRun, repoGit } from "./_lib.mjs";

const j = job();
if (expect(j, "the ticket was never filed")) {
  console.log(`stage ${j.stage}, lanes ${lanesRun(j).join(",")}`);
  expect(j.stage === "rejected", `stage is ${j.stage}, want rejected`);
  expect(!lanesRun(j).includes("build"), "it was built");
}
expect(repoGit("rev-parse", "main") === process.env.BENCH_MAIN_BEFORE, "main moved");
expect(repoGit("ls-tree", "--name-only", "staging", "test/").length > 0, "staging lost its tests");
done();
