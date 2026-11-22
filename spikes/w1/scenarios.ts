// What each fake role does, call by call, per scenario. A string is the file
// the role writes. `eLAST` becomes the job's latest stamped evidence id.
export type Step =
  | string
  | {
      file?: string;
      /** builder: edit the worktree (default true); gateFail leaves GATE_FAIL behind so the gate check fails. */
      edit?: boolean;
      gateFail?: boolean;
      rate?: true;
      hang?: true;
      sleepSec?: number;
      fail?: string;
      writeDrive?: true;
      addPrimitive?: string;
    };

const intake = (kind: string, risk: string, criteria = "") => `DECISION: ACCEPT\nKIND: ${kind}\nRISK: ${risk}\nREASON: scripted\n${criteria}`;
const CRITERIA = "## Criteria\n- [C1] the work file exists\n  proof: cmd test -d work\n  expect: exit 0\n";
const CRITERIA_BUG = "## Criteria\n- [C1] the regression test passes\n  proof: test test/regression\n  expect: exit 0\n  repro: true\n";
const CRITERIA_SQL = "## Criteria\n- [C1] the row is stored\n  proof: toolkit sql --q 'select 1'\n  expect: rows 1\n";
const BUILD = "STATUS: READY\n\nDid the work.";
const DRIVES_OK = "DRIVES: OK\n";
const PASS_CITING = "VERDICT: PASS\nEVIDENCE: eLAST\n";
const REVIEW_PASS = "VERDICT: PASS\n";
const REPORT = "<h1>Report</h1><p>Gate passed: {{eLAST}}</p>\n";

const straight = { builder: [BUILD], "verifier:drives": [DRIVES_OK], verifier: [PASS_CITING], "reviewer-code": [REVIEW_PASS], report: [REPORT] };
const low = { ...straight, intake: [intake("chore", "low", CRITERIA)] };

export const SCENARIOS: Record<string, Record<string, Step[]>> = {
  // feature, medium risk: intake → spec → build → gate → drives → verify → review(code) → ready → report (refused once) → done
  feature: { ...straight, intake: [intake("feature", "medium")], spec: [CRITERIA], report: ["<p>{{e999}}</p>", REPORT] },
  // low-risk chore: intake → build (no spec) → … → review with no lens → … → done
  chore: low,
  // bug, medium: intake → spec → repro (not reproduced, then reproduced) → build → … → done
  bug: { ...straight, intake: [intake("bug", "medium")], spec: [CRITERIA_BUG], repro: ["REPRO: NOT-REPRODUCED\n", "REPRO: FAILED-AS-EXPECTED\n"] },
  // bug, low: intake → repro twice without a reproduction → needs-info
  "bug-lost": { ...straight, intake: [intake("bug", "low", CRITERIA_BUG)], repro: ["REPRO: NOT-REPRODUCED\n"] },
  // Toolkit gap round trip: spec names a missing primitive → toolkit → spec; drives names one → toolkit → drives;
  // verify cites evidence from an older HEAD once (refused); ready waits for the Toolkit PR (paused toolkit-pr)
  gap: {
    ...straight,
    intake: [intake("feature", "medium")],
    spec: [CRITERIA_SQL],
    smith: [
      { file: "STATUS: READY\nPRIMITIVE: sql\n", addPrimitive: "sql" },
      { file: "STATUS: READY\nPRIMITIVE: drag\n", addPrimitive: "drag" },
    ],
    "verifier:drives": ["DRIVES: OK\nGAP: drag\n", { file: DRIVES_OK, writeDrive: true }],
    verifier: [PASS_CITING, "VERDICT: PASS\n"],
    report: ["<h1>Report</h1><p>No stamped proof to cite on the final HEAD in W1.</p>\n"],
  },
  // paused(backoff): the builder is rate limited once
  backoff: { ...low, builder: [{ rate: true }, BUILD] },
  // paused(ci): the spike sets the fake forge's CI to pending
  ci: low,
  // INCONCLUSIVE: free retry, paused(toolkit-ticket), ticket closed, twice more → needs-human; feedback → build → … → done
  inconclusive: { ...low, verifier: ["VERDICT: INCONCLUSIVE\n", "VERDICT: INCONCLUSIVE\n", "VERDICT: INCONCLUSIVE\n", "VERDICT: INCONCLUSIVE\n", PASS_CITING] },
  // round limit: gate fails three rounds → needs-human; feedback → … → done; feedback on done → build → … → done
  rounds: { ...low, builder: [{ file: BUILD, gateFail: true }, { file: BUILD, gateFail: true }, { file: BUILD, gateFail: true }, BUILD] },
  "reject-intake": { intake: ["DECISION: REJECT\nREASON: out of scope\n"] },
  "info-reject": { intake: ["DECISION: NEEDS-INFO\nQUESTION: which page?\n"] },
  "info-reply": { intake: ["DECISION: NEEDS-INFO\nQUESTION: which page?\n", "DECISION: REJECT\nREASON: a duplicate of 001\n"] },
  // READY with nothing changed: refused twice → needs-human
  "empty-build": { ...low, builder: [{ file: BUILD, edit: false }] },
  // BLOCKED → needs-human; then kitchen reject → rejected
  blocked: { ...low, builder: ["STATUS: BLOCKED\nREASON: needs a database\n"] },
  // two failed drive attempts on a reachable feature → needs-human
  "drives-fail": { ...low, "verifier:drives": ["DRIVES: FAILED\n"] },
  // kill -9 while the verifier writes drives (after build committed and published, after gate stamped)
  kill: { ...low, "verifier:drives": [{ hang: true }, DRIVES_OK] },
  // a slow builder, for --detach
  slow: { ...low, builder: [{ file: BUILD, sleepSec: 6 }] },
};
