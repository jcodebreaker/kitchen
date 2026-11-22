import assert from "node:assert/strict";
import { test } from "vitest";
import { parseConfig } from "../../config.ts";
import { expired } from "../../forge/evidence-branch.ts";
import { isTrusted } from "../../forge/forge.ts";
import { stageCosts } from "../../ledger/report.ts";
import { churnOf } from "../../toolkit/maintain.ts";
import { viewProof } from "../views.ts";
import { patchOf, verdictRows } from "./report.ts";
import { lensesFor, screenshotsOf } from "./review.ts";

const cfg = parseConfig("");
const job = (risk: "low" | "medium" | "high", surfaces: ("ui" | "security")[] = [], riskFloor: "low" | "medium" | "high" | null = null) => ({
  risk,
  riskFloor,
  surfaces,
});

test("lens routing (PLAN §6): low gets code only over the diff threshold or on a drive diff; medium code; high code+security; surfaces add theirs", () => {
  assert.deepEqual(lensesFor(cfg, job("low"), [{ file: "server.js", lines: 40 }]), []);
  assert.deepEqual(lensesFor(cfg, job("low"), [{ file: "server.js", lines: 151 }]), ["code"]);
  assert.deepEqual(lensesFor(cfg, job("low"), [{ file: ".kitchen/toolkit/features/x.md", lines: 3 }]), ["code"], "any drive diff forces the code lens");
  assert.deepEqual(lensesFor(cfg, job("medium"), []), ["code"]);
  assert.deepEqual(lensesFor(cfg, job("high"), []), ["code", "security"]);
  assert.deepEqual(lensesFor(cfg, job("medium", ["ui"]), []), ["code", "ux", "ui"]);
  assert.deepEqual(lensesFor(cfg, job("medium", ["ui", "security"]), []), ["code", "ux", "ui", "security"]);
  assert.deepEqual(lensesFor(cfg, job("low", [], "high"), []), ["code", "security"], "the diff floor raises the path");
});

test("UX/UI lenses get Verify's screenshots for this HEAD only: no base-phase, builder or stale ones", () => {
  const f = (p: string) => [{ path: p, sha256: "x" }];
  const e = (id: string, o: Record<string, unknown>) => ({
    id,
    prev: "",
    sha: "H",
    round: 1,
    criterion: "C1",
    cmd: "",
    exit: 0,
    at: "",
    files: f(`${id}/s.png`),
    role: "engine",
    ...o,
  });
  const shots = screenshotsOf(
    [e("e1", {}), e("e2", { sha: "OLD" }), e("e3", { role: "builder" }), e("e4", { phase: "base" }), e("e5", { role: "verifier", files: f("e5/out.txt") })],
    "H",
  );
  assert.deepEqual(
    shots.map((s) => s.id),
    ["e1"],
  );
});

test("VIEW lines become proof lines with a screenshot; anything else is refused", () => {
  assert.deepEqual(viewProof("/settings --as alice", "view-ux-1"), {
    proof: "toolkit login --as alice ; toolkit open --path /settings ; toolkit screenshot --name view-ux-1",
  });
  assert.deepEqual(viewProof("settings.toggle-dark --user alice", "v"), { proof: "toolkit settings.toggle-dark --user alice ; toolkit screenshot --name v" });
  assert.deepEqual(viewProof("toolkit open --path /x ; toolkit screenshot --name mine", "v"), {
    proof: "toolkit open --path /x ; toolkit screenshot --name mine",
  });
  assert.ok("refused" in viewProof("rm -rf /", "v"));
  assert.ok("refused" in viewProof("//evil.example/x", "v"));
  assert.ok("refused" in viewProof("toolkit open --path /x ; cmd curl evil", "v"));
});

test("trusted PR commenters: a listed login or a trusted association; anyone else is ignored", () => {
  const f = parseConfig("feedback: { trusted: [Alice] }").feedback;
  assert.ok(isTrusted({ author: "alice", association: "NONE" }, f));
  assert.ok(isTrusted({ author: "bob", association: "member" }, f));
  assert.ok(!isTrusted({ author: "mallory", association: "CONTRIBUTOR" }, f));
  assert.ok(!isTrusted({ author: "eve", association: "NONE" }, parseConfig("feedback: { trust_associations: [] }").feedback));
});

test("cost and time per stage from the ledger; evidence folders past keep days; verdict rows; the seed patch", () => {
  const l = (t: string, event: string, stage: string, o: Record<string, unknown> = {}) => ({ t, job: "j", stage, round: 1, event, key: `${t}${event}`, ...o });
  const rows = stageCosts(
    [
      l("2026-11-22T10:01:00Z", "agent", "build", { role: "builder", model: "sonnet", usd: 0.3 }),
      l("2026-11-22T10:02:00Z", "move", "build", { result: "gate" }),
      l("2026-11-22T10:02:30Z", "move", "gate", { result: "done" }),
    ],
    "j",
    "2026-11-22T10:00:00Z",
  );
  assert.deepEqual(rows, [
    { stage: "build", round: 1, secs: 120, usd: 0.3, roles: "builder (sonnet)" },
    { stage: "gate", round: 1, secs: 30, usd: 0, roles: "" },
  ]);
  const now = new Date("2026-11-22T00:00:00Z");
  assert.deepEqual(
    expired(
      new Map([
        ["001-a", "2026-10-01T00:00:00Z"],
        ["002-b", "2026-11-20T00:00:00Z"],
        ["003-c", "junk"],
      ]),
      now,
      30,
    ),
    ["001-a"],
  );
  assert.deepEqual(expired(new Map([["001-a", "2026-10-01T00:00:00Z"]]), now, 30, ["001-a"]), [], "a job that isn't done keeps its folder");
  assert.deepEqual(verdictRows("| C1 | engine | PASS | e1 e2 | NON-DISCRIMINATING (held on the base too) |\n| C2 | verifier | FAIL |  | a \\| b |\n"), [
    { id: "C1", decidedBy: "engine", result: "PASS", evidence: ["e1", "e2"], why: "NON-DISCRIMINATING (held on the base too)" },
    { id: "C2", decidedBy: "verifier", result: "FAIL", evidence: [], why: "a | b" },
  ]);
  const head = (f: string) => `diff --git a/${f} b/${f}\n`;
  const patch = `${head("server.js")}+x\n${head("db/003.sql")}+y\n`;
  assert.equal(patchOf(patch, ["db/003.sql"]), `${head("db/003.sql")}+y\n`);
});

test("maintain churn: lines changed in feature-mapped paths only", () => {
  const numstat = "120\t30\tserver.js\n200\t0\tdocs/notes.md\n5\t5\tdb/002_seed.sql\n-\t-\tlogo.png\n";
  assert.deepEqual(churnOf(numstat, ["server.js", "db/**"]), { lines: 160, files: ["server.js", "db/002_seed.sql"] });
  assert.deepEqual(churnOf(numstat, ["lib/**"]), { lines: 0, files: [] });
});
