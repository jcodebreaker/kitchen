import assert from "node:assert/strict";
import { test } from "vitest";
import { lintFeatureFile } from "./feature-lint.ts";
import { gateOutcome } from "./gate.ts";
import { riskFloor } from "./risk-floor.ts";
import { lintSpec, newDrivesOf } from "./spec-lint.ts";

const toolkit = { primitives: ["login", "press", "read", "open", "reload", "screenshot", "http", "type"], drives: { "settings.toggle-dark": ["user"] } };
const lint = (md: string, kind: string | null = "feature", prot: string[] = ["kitchen.yaml"]) => lintSpec(md, { kind, toolkit, protected: prot });
const spec = (...items: string[]) => `## Criteria\n${items.join("\n")}\n`;
const C = (id: string, text: string, proof: string, expect?: string, repro = false) =>
  [`- [${id}] ${text}`, `  proof: ${proof}`, ...(expect !== undefined ? [`  expect: ${expect}`] : []), ...(repro ? ["  repro: true"] : [])].join("\n");

test("a good contract passes: existing drive, primitive chain, cmd, test, judged visual", () => {
  const r = lint(
    spec(
      C(
        "C1",
        "Dark mode persists across a reload",
        "toolkit settings.toggle-dark --user alice ; toolkit reload ; toolkit read --target body --attr class",
        'contains "theme-dark"',
      ),
      C("C2", "The settings page shows the saved theme", "toolkit settings.toggle-dark --user alice", '$theme == "Dark" and json $me.body.theme == "dark"'),
      C("C3", "Server still parses", "cmd node --check server.js", "exit 0"),
      C("C4", "Theme helper is unit-tested", "test test/theme.test.js"),
      C(
        "C5",
        "The header looks right in dark mode",
        "toolkit settings.toggle-dark --user alice ; toolkit screenshot --name header",
        "judged   # only an agent can decide",
      ),
    ),
  );
  assert.equal(r.reason, undefined);
  assert.ok(r.ok);
  assert.equal(r.criteria[4].expect, "judged", "a trailing comment is not part of the expect");
});

test("rule 1: every criterion has a proof of kind toolkit, cmd or test", () => {
  assert.match(lint(spec("- [C1] something")).reason ?? "", /C1 has no proof/);
  assert.match(lint(spec(C("C1", "x", "curl http://x", "ok"))).reason ?? "", /toolkit/);
  assert.match(lint(spec(C("C1", "x", "toolkit read --target body"))).reason ?? "", /needs an expect/);
  assert.match(lint("no criteria here").reason ?? "", /no criteria/);
});

test("rule 2: primitives from describe; drives exist with their args, or are declared new", () => {
  const gap = lint(spec(C("C1", "x", "toolkit drag --from a --to b", "ok")));
  assert.equal(gap.ok, false);
  assert.equal(gap.missingPrimitive, "drag", "a missing primitive is a Toolkit gap");
  assert.match(lint(spec(C("C1", "x", "toolkit settings.display-name --user alice", "ok"))).reason ?? "", /New drives/);
  const declared = `${spec(C("C1", "x", "toolkit settings.display-name --user alice", '$name == "Al"'))}\n## New drives\n- settings.display-name: open settings, type the name, save it, read the header\n`;
  assert.ok(lint(declared).ok, "a new feature drive for this job is allowed when declared");
  assert.deepEqual(newDrivesOf(declared), ["settings.display-name"]);
  assert.match(lint(spec(C("C1", "x", "toolkit settings.toggle-dark --as alice", "ok"))).reason ?? "", /takes --user/);
  assert.match(lint(spec(C("C1", "x", "toolkit read --target body --id p2", "ok"))).reason ?? "", /set by the engine/);
});

test("rule 3: judged only for a visual or wording criterion; mechanical expects must parse", () => {
  assert.match(lint(spec(C("C1", "Saving works", "toolkit settings.toggle-dark --user alice", "judged"))).reason ?? "", /only for a visual or wording/);
  assert.ok(lint(spec(C("C1", "The error message reads clearly", "toolkit settings.toggle-dark --user alice", "judged"))).ok);
  assert.match(lint(spec(C("C1", "The page looks right", "cmd true", "judged"))).reason ?? "", /needs a toolkit proof/);
  assert.match(lint(spec(C("C1", "x", "toolkit settings.toggle-dark --user alice", "theme is dark"))).reason ?? "", /C1: expect/);
});

test("rule 4: nothing touches a protected path or the Toolkit's primitives", () => {
  assert.match(lint(spec(C("C1", "x", "cmd cat kitchen.yaml", "exit 0"))).reason ?? "", /protected path kitchen.yaml/);
  assert.match(lint(spec(C("C1", "x", "test .kitchen/toolkit/lib/common.mjs", "exit 0"))).reason ?? "", /protected/);
  assert.match(lint(spec(C("C1", "Edit .kitchen/toolkit/bin/dev to add a flag", "cmd true", "exit 0"))).reason ?? "", /protected/);
  assert.match(lint(spec(C("C1", "x", "cmd node scripts/x.js", "exit 0")), "feature", ["scripts/**"]).reason ?? "", /scripts\/x.js/);
});

test("rule 5: a bug needs a repro: true criterion with a mechanical expect", () => {
  const p = "toolkit settings.toggle-dark --user alice ; toolkit reload ; toolkit read --target body --attr class";
  assert.match(lint(spec(C("C1", "x", p, 'contains "theme-dark"')), "bug").reason ?? "", /repro: true/);
  assert.ok(lint(spec(C("C1", "x", p, 'contains "theme-dark"', true)), "bug").ok);
  assert.ok(!lint(spec(C("C1", "The toggle looks right", p, "judged", true)), "bug").ok, "a judged repro can't fail mechanically");
});

test("rule 6: ids are unique", () => {
  assert.match(lint(spec(C("C1", "x", "cmd true", "exit 0"), C("C1", "y", "cmd true", "exit 0"))).reason ?? "", /duplicate id C1/);
});

test("feature drive files hold no code", () => {
  const ok = "# F\n\n```drive\ndrive: f.go\nargs: [user]\nsteps:\n  - login: { as: $user }\n  - read: { target: body }\n    save: page\n```\n";
  assert.deepEqual(lintFeatureFile(ok, toolkit.primitives), { ok: true, drives: ["f.go"], gaps: [] });
  const js = `${ok}\n\`\`\`js\ndocument.body.className = 'theme-dark'\n\`\`\`\n`;
  assert.match((lintFeatureFile(js, toolkit.primitives) as { reason: string }).reason, /can't hold code/);
  const script = "```drive\ndrive: f.go\nsteps:\n  - run: |\n      echo Dark\n```\n";
  assert.equal(lintFeatureFile(script, toolkit.primitives).ok, false, "multi-line values are outside the format");
  const evalStep = "```drive\ndrive: f.go\nsteps:\n  - eval: { code: \"return 'Dark'\" }\n```\n";
  assert.match((lintFeatureFile(evalStep, toolkit.primitives) as { reason: string }).reason, /would run code/);
  const gap = "```drive\ndrive: f.go\nsteps:\n  - drag: { from: a, to: b }\n```\n";
  assert.deepEqual(lintFeatureFile(gap, toolkit.primitives), { ok: true, drives: ["f.go"], gaps: ["drag"] }, "an unknown primitive is a gap");
  assert.equal(lintFeatureFile("# nothing", toolkit.primitives).ok, false);
});

test("risk floor: high_paths and diff size, never lower than it was", () => {
  const cfg = { high_paths: ["**/migrations/**", "**/auth/**"], risk_floor: { diff_lines_medium: 300, diff_lines_high: 1000 } };
  assert.equal(riskFloor([{ file: "server.js", lines: 40 }], cfg), "low");
  assert.equal(riskFloor([{ file: "server.js", lines: 300 }], cfg), "medium");
  assert.equal(
    riskFloor(
      [
        { file: "a.js", lines: 600 },
        { file: "b.js", lines: 400 },
      ],
      cfg,
    ),
    "high",
  );
  assert.equal(riskFloor([{ file: "db/migrations/003.sql", lines: 2 }], cfg), "high");
  assert.equal(riskFloor([{ file: "src/auth/login.ts", lines: 1 }], cfg), "high");
  assert.equal(riskFloor([], cfg), "low");
});

test("gate is pinned to HEAD", () => {
  const H = "a".repeat(40);
  const c = { name: "syntax", ok: true, exit: 0, secs: 0.1, id: "e1", cmd: "node --check server.js", sha: H, dirty: false };
  assert.equal(gateOutcome(H, H, [c]).result, "PASS");
  assert.equal(gateOutcome(H, H, [{ ...c, ok: false, exit: 1 }]).result, "FAIL");
  assert.match(gateOutcome(H, "b".repeat(40), [c]).why ?? "", /HEAD moved/);
  assert.match(gateOutcome(H, H, [{ ...c, sha: "c".repeat(40) }]).why ?? "", /not HEAD/);
  assert.match(gateOutcome(H, H, [{ ...c, dirty: true }]).why ?? "", /uncommitted/);
  assert.equal(gateOutcome(H, H, []).result, "PASS", "no checks configured");
});
