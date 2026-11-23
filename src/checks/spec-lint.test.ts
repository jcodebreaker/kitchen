import assert from "node:assert/strict";
import { test } from "vitest";
import { type BaseCheck, baseNegativeProblems, guardBaseProblems } from "../engine/stages/base-check.ts";
import { evaluate, parseExpect } from "../proof/assert.ts";
import { parseProof } from "../proof/proof-line.ts";
import { changedExistingDrive, lintFeatureFile } from "./feature-lint.ts";
import { gateOutcome } from "./gate.ts";
import { riskFloor, seedTouched } from "./risk-floor.ts";
import { guardCriteria, lintSpec, newDrivesOf, parseCriteria, parseRequirements, remarkProblems, withSpecMarks } from "./spec-lint.ts";

test('rule 3: `$x == ""` counts as a negative: an earlier step must make something', () => {
  const read = 'toolkit login --as alice ; toolkit read --target "[data-testid=owner]" --save owner';
  assert.match(lint(spec(C("C1", "x", read, '$owner == ""'))).reason ?? "", /never existed/);
  const made = `${spec(C("C1", "x", `toolkit projects.make --user bob-admin --name "Bob plan" ; ${read}`, '$owner == ""'))}\n## New drives\n- projects.make: create a project\n`;
  assert.equal(lint(made).reason, undefined);
});

test("rule 7: criteria cover intake's requirements; a negative one needs a criterion asserting an absence", () => {
  const intake = [
    "## Requirements",
    "- R1: Admins see every user's projects with the owner shown",
    "- R2 (negative): regular users see no owner",
    "- R3 (out of scope): export to CSV — the ticket mentions it in passing",
    "Note: R3 rescoped, see REASON.",
  ].join("\n");
  const reqs = parseRequirements(intake);
  assert.deepEqual(
    reqs.map((r) => [r.id, r.negative, r.outOfScope]),
    [
      ["R1", false, false],
      ["R2", true, false],
      ["R3", false, true],
    ],
  );
  const L = (md: string) => lintSpec(md, { kind: "feature", toolkit, protected: [], requirements: reqs });
  const pos = C("C1", "Admin sees the owner", "toolkit login --as bob ; toolkit read --target owner --save o", '$o == "alice"');
  const neg = C(
    "C2",
    "Alice sees no owner",
    'toolkit settings.toggle-dark --user bob ; toolkit login --as alice ; toolkit read --target "[data-testid=owner]" --save o',
    '$o == ""',
  );
  assert.match(L(spec(pos, neg)).reason ?? "", /C1 covers no requirement/);
  assert.match(L(spec(`${pos}\n  covers: R1`, `${neg}\n  covers: R9`)).reason ?? "", /C2 covers R9, which intake.md does not list/);
  assert.match(L(spec(`${pos}\n  covers: R1`)).reason ?? "", /R2 .* is covered by no criterion/);
  const posOnly = C("C2", "Alice sees her project", "toolkit login --as alice ; toolkit open --path /projects", 'text "onboarding" visible');
  assert.match(L(spec(`${pos}\n  covers: R1`, `${posOnly}\n  covers: R2`)).reason ?? "", /R2 says what must not happen/);
  assert.equal(L(spec(`${pos}\n  covers: R1`, `${neg}\n  covers: R2  # the negative`)).reason, undefined, "R3 is out of scope");
  assert.match(lintSpec(spec(`${pos}\n  covers: R1`), { kind: "feature", toolkit, requirements: [] }).reason ?? "", /lists no requirements/);
});

test("rule 7: an (unchanged) requirement is a regression guard, proven positively; only a true (negative) needs an absence (dogfood: 5 of 6 intakes deadlocked)", () => {
  const intake = [
    "## Requirements",
    "- R1: `kitchen status --json` prints the jobs as JSON",
    "- R2 (unchanged): `kitchen status` without --json prints the same table as before",
    "- R3 (negative): no ANSI colour codes in the JSON output",
    "- R4 (negative, unchanged): marked both, it stays a negative",
  ].join("\n");
  const reqs = parseRequirements(intake);
  assert.deepEqual(
    reqs.map((r) => [r.id, r.negative, !!r.unchanged]),
    [
      ["R1", false, false],
      ["R2", false, true],
      ["R3", true, false],
      ["R4", true, false],
    ],
  );
  const three = reqs.slice(0, 3);
  const L = (md: string) => lintSpec(md, { kind: "feature", toolkit, protected: [], requirements: three });
  const json = `${C("C1", "status --json is JSON", "cmd node src/cli.ts status --json", 'json .jobs != ""')}\n  covers: R1`;
  const noAnsi = `${C("C3", "no colour codes", "cmd node src/cli.ts status --json", 'not contains "\\u001b["')}\n  covers: R3`;
  // A positive "unchanged" criterion: the old command still prints the same header, exit 0.
  const same = `${C("C2", "plain status keeps the table it had before", "cmd node src/cli.ts status", 'contains "ID  STAGE" and exit 0')}\n  covers: R2`;
  assert.equal(L(spec(json, same, noAnsi)).reason, undefined, "a positive criterion covers the guard");
  const judgedGuard = `${C("C2", "plain status table layout looks as before", "toolkit screenshot --name s", "judged")}\n  covers: R2`;
  assert.match(L(spec(json, judgedGuard, noAnsi)).reason ?? "", /R2 guards existing behaviour/);
  // The true negative still needs its absence.
  const noAnsiPositive = `${C("C3", "json parses", "cmd node src/cli.ts status --json", "exit 0")}\n  covers: R3`;
  assert.match(L(spec(json, same, noAnsiPositive)).reason ?? "", /R3 says what must not happen/);
  // Only a criterion that covers guards alone is a guard for the base check.
  const both = `${C("C4", "x", "cmd node src/cli.ts status", 'contains "ID"')}\n  covers: R1, R2`;
  assert.deepEqual(guardCriteria(parseCriteria(spec(json, same, noAnsi, both)), three), ["C2"]);
  // The spec may re-mark a negative as a boundary (a-primitive: "the UI does not show it"), nothing else: it stays a
  // negative (its absence must still be asserted), marked so its absence may hold on the base.
  const re = withSpecMarks(reqs, "## Requirements\n- R3 (unchanged): the JSON output stays as it is, no colours today\n- R1 (out of scope): x\n");
  assert.deepEqual(
    re.map((r) => [r.id, r.negative, !!r.unchanged, !!r.remarked, r.outOfScope]),
    [
      ["R1", false, false, false, false],
      ["R2", false, true, false, false],
      ["R3", true, false, true, false],
      ["R4", true, false, false, false],
    ],
  );
  assert.match(re[2].text, /re-marked \(unchanged\) by the spec/);
});

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

test('quotes inside a proof value: \\" in "…" is a quote (as in the drive format); in \'…\' it is refused with how to quote', () => {
  const seg = (p: string) => parseProof(p)[0] as { args: Record<string, string> };
  assert.equal(seg('toolkit read --target "a[href=\\"/projects/x\\"]"').args.target, 'a[href="/projects/x"]');
  assert.equal(seg("toolkit read --target 'a[href=\"/projects/x\"]'").args.target, 'a[href="/projects/x"]');
  assert.equal(seg('toolkit read --target "a\\\\b"').args.target, "a\\b");
  assert.equal(
    seg('toolkit read --target "x;y" ; toolkit read --target "a\\";b"').args.target,
    "x;y",
    "an escaped quote doesn't end the value or split the chain",
  );
  assert.equal((parseProof('toolkit read --target "x" ; toolkit read --target "a\\";b"')[1] as { args: Record<string, string> }).args.target, 'a";b');
  const r = lint(spec(C("C1", "x", "toolkit read --target 'a[href=\\\"/x\\\"]'", "ok")));
  assert.match(r.reason ?? "", /C1: .*inside '…' a backslash is kept as is.*--target "a\[href=\\"\/x\\"\]"/);
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

test("rule 3: judged only for layout, appearance, style, tone or copy quality, with a screenshot; mechanical expects must parse", () => {
  const shot = "toolkit settings.toggle-dark --user alice ; toolkit screenshot --name s";
  assert.match(lint(spec(C("C1", "Saving works", shot, "judged"))).reason ?? "", /only for layout/);
  for (const text of ["The error message says Saved", "The button is labelled Save", "The header reads Welcome", "The column is 200px width"])
    assert.match(lint(spec(C("C1", text, shot, "judged"))).reason ?? "", /only for layout/, `${text}: mechanical, not judged`);
  for (const text of ["The error copy is friendly in tone", "The settings layout is aligned", "The header looks right in dark mode"])
    assert.ok(lint(spec(C("C1", text, shot, "judged"))).ok, text);
  assert.match(
    lint(spec(C("C1", "The header looks right", "toolkit settings.toggle-dark --user alice", "judged"))).reason ?? "",
    /must take a screenshot/,
    "a judged proof with nothing to look at",
  );
  const viaDrive = lintSpec(spec(C("C1", "The header looks right", "toolkit settings.toggle-dark --user alice", "judged")), {
    kind: "feature",
    toolkit: { ...toolkit, screenshots: ["settings.toggle-dark"] },
  });
  assert.ok(viaDrive.ok, "a drive that takes a screenshot counts");
  const newDrive = `${spec(C("C1", "The header looks right", "toolkit settings.dark-shot --user alice", "judged"))}\n## New drives\n- settings.dark-shot: sign in, toggle dark, screenshot the header\n`;
  assert.ok(lint(newDrive).ok, "a new drive described as taking a screenshot counts");
  assert.match(lint(spec(C("C1", "The page looks right", "cmd true", "judged"))).reason ?? "", /needs a toolkit proof/);
  assert.match(lint(spec(C("C1", "x", "toolkit settings.toggle-dark --user alice", "theme is dark"))).reason ?? "", /C1: expect/);
});

test("rule 3: a negative is backed by a creating step, by a value read after a making step, or else by the base check (benchmark regression)", () => {
  const leak = "toolkit login --as alice ; toolkit open --path /projects";
  // (c) unbacked: not refused here, left to the base check, which must show the thing on the base.
  const bare = lint(spec(C("C1", "Alice doesn't see Bob's project", leak, 'text "Bob plan" not visible')));
  assert.ok(bare.ok);
  assert.deepEqual(bare.baseNegatives, [{ criterion: "C1", clause: 'text "Bob plan" not visible' }]);
  // (a) created by an earlier step: nothing left to the base.
  const made = `${spec(
    C(
      "C1",
      "Alice doesn't see Bob's project",
      'toolkit projects.make --user bob-admin --name "Bob plan" ; toolkit login --as alice ; toolkit open --path /projects',
      'text "Bob plan" not visible and text "Onboarding" visible',
    ),
  )}\n## New drives\n- projects.make: sign in as user, create a project named name\n`;
  assert.deepEqual(lint(made).baseNegatives, [], "created by an earlier step");
  // … or named in it: the row of the task an earlier command added (b-done-many), not a word of a path or selector.
  const cli = { ...toolkit, primitives: [...toolkit.primitives, "cli"] };
  // … when a positive clause of the same expect shows the made thing (final fixes L2).
  const zebra = 'toolkit cli --argv "add Zebra" ; toolkit cli --argv "done 7 99" ; toolkit cli --argv "list --all"';
  assert.deepEqual(
    lintSpec(spec(C("C1", "x", zebra, 'contains "Zebra" and not contains "[x]   7  Zebra"')), { kind: "feature", toolkit: cli }).baseNegatives,
    [],
  );
  assert.equal(lintSpec(spec(C("C1", "x", zebra, 'not contains "[x]   7  Zebra"')), { kind: "feature", toolkit: cli }).baseNegatives.length, 1);
  assert.equal(lint(spec(C("C1", "x", leak, 'text "projects" not visible'))).baseNegatives.length, 1);
  // (b) `!=` on a value read after a step that makes something (the total after an item is added is not the old one).
  const add = "toolkit http --method POST --path /cart --body '{\"qty\":3}' ; toolkit read --target total --save t";
  assert.deepEqual(lint(spec(C("C1", "x", add, '$t != "0"'))).baseNegatives, []);
  // … not a value read before any making step, and not `not contains` on a saved page (final fixes H1): the base check.
  assert.equal(lint(spec(C("C1", "x", `${leak} ; toolkit read --target owner --save o`, '$o != "bob"'))).baseNegatives.length, 1);
  assert.equal(
    lint(spec(C("C1", "x", "toolkit read --target total --save t ; toolkit http --method POST --path /cart --body '{\"qty\":3}'", '$t != "0"'))).baseNegatives
      .length,
    1,
    "read before the write",
  );
  assert.equal(lint(spec(C("C1", "x", add, '$t not contains "0"'))).baseNegatives.length, 1);
  assert.equal(lint(spec(C("C1", "x", "toolkit settings.toggle-dark --user alice", '$theme != "Light"'))).baseNegatives.length, 1);
  // Equality to empty still needs a making step, refused at once.
  assert.match(lint(spec(C("C1", "x", `${leak} ; toolkit read --target owner --save o`, '$o == ""'))).reason ?? "", /never existed/);
  assert.ok(lint(spec(C("C1", "x", "cmd node --check server.js", "exit != 1"))).ok, "an exit code is not a negative expect");
});

test("rule 3 (c): the base check backs a negative only when it is FALSE on the base", () => {
  const pending = [{ criterion: "C3", clause: 'text "Appearance" not visible' }];
  const base = (status: string, pass: boolean, skipped = false): BaseCheck => ({
    head: "b",
    key: "k",
    results: skipped ? [] : [{ criterion: "C3", status, evidence: ["e4"], clauses: [{ clause: 'text "Appearance" not visible', pass, got: "" }] }],
    skipped: skipped ? [{ criterion: "C3", why: "needs what the base doesn't have: x.y" }] : [],
    passing: [],
  });
  assert.deepEqual(
    baseNegativeProblems(pending, base("assert-fail", false)),
    [],
    "the old heading shows on the base: its absence after the change means something",
  );
  assert.match(baseNegativeProblems(pending, base("pass", true))[0], /already holds on the base.*\(unchanged\)/);
  assert.match(baseNegativeProblems(pending, base("step-failed", false))[0], /doesn't run on the base/);
  assert.match(baseNegativeProblems(pending, base("", false, true))[0], /can't be checked on the base/);
  assert.match(baseNegativeProblems(pending, null)[0] ?? "", /could not run/, "nothing ran: refused, never waved through (H3)");
  // A negative the spec re-marked as a boundary (its criterion a guard) may hold on the base.
  assert.deepEqual(baseNegativeProblems(pending, base("pass", true), ["C3"]), []);
  // A regression guard must hold on the base (d-control-version: `json .ok` on an http step's {status, body}).
  assert.match(guardBaseProblems(["C3"], base("assert-fail", false))[0], /guards existing behaviour .* fails on the current code/);
  assert.deepEqual(guardBaseProblems(["C3"], base("pass", true)), []);
});

test("rule 5: a repro can fail as expected; JSON args parse; rule 9: seed users; every problem is reported at once", () => {
  const D = { kind: "bug", toolkit: { ...toolkit, seedUsers: ["alice", "bob-admin"] } };
  const post = "toolkit http --method POST --path /orders --expect_status 201 --body '{\"qty\":100}'";
  assert.match(lintSpec(spec(C("C1", "x", post, "ok", true)), D).reason ?? "", /expect: ok. can never fail as expected/);
  assert.match(lintSpec(spec(C("C1", "x", `${post} ; toolkit read --target status --equals 201`, "ok and exit 0", true)), D).reason ?? "", /read --equals/);
  assert.ok(lintSpec(spec(C("C1", "x", "toolkit http --method POST --path /orders ; toolkit read --target status --save code", '$code == "201"', true)), D).ok);
  assert.match(
    lintSpec(
      spec(C("C1", "x", "toolkit http --method POST --path /orders --expect_status 400 ; toolkit read --target status --save code", '$code == "201"', true)),
      D,
    ).reason ?? "",
    /pins an error outcome/,
    "d-qty-100: the bug's own status pinned passes on the base and fails once fixed",
  );
  const cli = { ...toolkit, primitives: [...toolkit.primitives, "cli"] };
  assert.match(
    lintSpec(spec(C("C1", "x", 'toolkit cli --argv ["add","0123456789x"]', 'contains "too long"')), { kind: "feature", toolkit: cli }).reason ?? "",
    /not valid JSON/,
  );
  assert.ok(lintSpec(spec(C("C1", "x", `toolkit cli --argv '["add","0123456789x"]'`, 'contains "too long"')), { kind: "feature", toolkit: cli }).ok);
  const F = { kind: "feature", toolkit: { ...toolkit, primitives: [...toolkit.primitives, "sql"], seedUsers: ["alice", "bob-admin"] } };
  assert.match(lintSpec(spec(C("C1", "x", "toolkit login --as bob ; toolkit open --path /", "ok")), F).reason ?? "", /user "bob", who is not a seed user/);
  assert.match(lintSpec(spec(C("C1", "x", "toolkit sql --query \"SELECT 1 FROM users WHERE username = 'bob'\" --save r", "ok")), F).reason ?? "", /"bob"/);
  assert.ok(lintSpec(spec(C("C1", "x", "toolkit login --as bob-admin ; toolkit open --path /", "ok")), F).ok);
  const two = lintSpec(spec(C("C1", "x", "toolkit login --as bob ; toolkit open --path /", "ok"), C("C2", "y", "toolkit nope", "ok")), F);
  assert.match(two.reason ?? "", /"bob"[\s\S]*\n.*C2 needs primitive nope/, "both problems, one per line");
  assert.equal(two.missingPrimitive, "nope");
});

test("rule 4: a cmd proof stays in the worktree: no outside path, home, env dump or network tool", () => {
  for (const cmd of [
    "cat /etc/passwd",
    "cat ../other/secret",
    "ls ~",
    "echo $HOME",
    "env",
    "printenv AWS_KEY",
    "curl http://example.com",
    "wget x",
    "nc -l 9",
    "ssh host",
    "scp a b:c",
    "node x.js > /tmp/out",
    "node x.js >../out",
    "/usr/bin/curl x",
  ])
    assert.match(lint(spec(C("C1", "x", `cmd ${cmd}`, "exit 0"))).reason ?? "", /cmd proof is refused/, cmd);
  for (const cmd of ["node --check server.js", "node x.js > out.txt 2>/dev/null", "npm test -- test/a.test.js"])
    assert.ok(lint(spec(C("C1", "x", `cmd ${cmd}`, "exit 0"))).ok, cmd);
  assert.match(lint(spec(C("C1", "x", "test ../outside.test.js"))).reason ?? "", /test proof is refused/);
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
  assert.match(lint(spec(C("C1", "x", p, 'contains "theme-dark"', true)), "feature").reason ?? "", /only for a bug/, "repro: true on a feature");
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
  // A builder diff touching seed data or migrations: high, and listed for review (gate writes seed-diff.md).
  const seeds = { ...cfg, seed_paths: ["db/**", "**/*seed*"] };
  assert.equal(riskFloor([{ file: "db/002_seed.sql", lines: 1 }], seeds), "high");
  assert.deepEqual(seedTouched([{ file: "db/003_names.sql" }, { file: "server.js" }], seeds), ["db/003_names.sql"]);
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

test("a job may add drives to a feature file but not change an existing one", () => {
  const a = "```drive\ndrive: f.a\nsteps:\n  - read: { target: body }\n```\n";
  const b = "```drive\ndrive: f.b\nsteps:\n  - reload: {}\n```\n";
  assert.equal(changedExistingDrive(a, `${a}\n${b}`), null, "added a drive");
  assert.match(changedExistingDrive(a, a.replace("body", "main")) ?? "", /f.a already exists/);
  assert.match(changedExistingDrive(a, b) ?? "", /f.a already exists/, "removed");
});

// Final fixes: the reviewer's probes (scratchpad probe.ts, remark.ts), each one a must-refuse.
test("probes H1/L1/L2: a negative with nothing made is left to the base check, where holding is refused", () => {
  const view = {
    primitives: ["open", "read", "http", "cli", "text", "screenshot", "sql"],
    drives: { "projects.create": ["user", "name"] },
    seedUsers: ["alice", "bob"],
  };
  const reqs = [{ id: "R1", text: "alice must not see Bob's plan", negative: true, outOfScope: false }];
  const L = (proof: string, expect: string) =>
    lintSpec(`## Criteria\n- [C1] x\n  proof: ${proof}\n  expect: ${expect}\n  covers: R1\n`, { kind: "feature", toolkit: view, requirements: reqs });
  const probes: [string, string][] = [
    ["toolkit open --path /projects --as alice", 'text "Bob plan" not visible'],
    // H1: a saved page or value is not backing by itself.
    ["toolkit open --path /projects --as alice ; read --target main --save page", '$page not contains "Bob plan"'],
    ['toolkit open --path /projects --as alice ; read --target "li:first-child" --save t', '$t != "Bob plan"'],
    // L1: `--as bob` makes nothing ("Bob plan" contains "bob").
    ["toolkit open --path /projects --as bob ; open --path /projects --as alice", 'text "Bob plan" not visible'],
    // L2: a phrase holding a made word, with nothing showing the made thing; a cli that only reads.
    ['toolkit cli --argv "add Zebra" ; cli --argv "list"', 'not contains "Zebra (overdue)"'],
    ['toolkit cli --argv "list --overdue" ; cli --argv "stats"', 'not contains "overdue: 3"'],
  ];
  // On the base none of them shows the thing: every one holds there, so every one is refused.
  for (const [proof, expect] of probes) {
    const r = L(proof, expect);
    assert.ok(r.ok, `${proof} :: ${r.reason}`);
    assert.deepEqual(r.baseNegatives, [{ criterion: "C1", clause: expect }], `${proof} is not backed by the lint alone`);
    const held: BaseCheck = {
      head: "b",
      key: "k",
      results: [{ criterion: "C1", status: "pass", evidence: ["e1"], clauses: [{ clause: expect, pass: true, got: "" }] }],
      skipped: [],
      passing: ["C1"],
    };
    assert.match(baseNegativeProblems(r.baseNegatives, held)[0] ?? "", /already holds on the base/, proof);
  }
  // What still backs one: the thing made by a making step with that text; a made word shown by a positive clause.
  assert.deepEqual(
    L('toolkit projects.create --user bob --name "Bob plan" ; open --path /projects --as alice', 'text "Bob plan" not visible').baseNegatives,
    [],
  );
  assert.deepEqual(L('toolkit cli --argv "add Zebra" ; cli --argv "list"', 'contains "Zebra" and not contains "Zebra (overdue)"').baseNegatives, []);
});

test("probe H1 at run time: a saved value that is an error page proves no absence", () => {
  const cs = parseExpect('$page not contains "Bob plan"');
  const r = evaluate(cs, { ok: true, exit: 0, output: "", vars: { page: "403 Forbidden: admins only" } });
  assert.equal(r.pass, false);
  assert.match(r.why ?? "", /error page/);
  // … nor a saved http response that failed, whatever its body says.
  const j = evaluate(parseExpect('$r != "Bob plan"'), {
    ok: true,
    exit: 0,
    output: "",
    vars: { r: '{"error":"nope"}' },
    responses: { r: { status: 403, full: '{"status":403,"body":{"error":"nope"}}' } },
  });
  assert.equal(j.pass, false);
  assert.match(j.why ?? "", /status 403/);
  // An error the same expect asserts is the expected outcome.
  assert.equal(
    evaluate(parseExpect('$page contains "Forbidden" and $page not contains "Bob plan"'), {
      ok: true,
      exit: 0,
      output: "",
      vars: { page: "Forbidden: admins only" },
    }).pass,
    true,
  );
});

test("probe H2: a re-marked negative still needs its absence asserted; it may hold on the base; never on a security job", () => {
  const view = { primitives: ["open", "read", "http", "cli", "text", "screenshot"], drives: {}, seedUsers: ["alice", "bob"] };
  const intake = parseRequirements("## Requirements\n- R1: admins see each project's owner\n- R2 (negative): regular users see no owner\n");
  const owner = '- [C1] admin sees owner\n  proof: toolkit open --path /projects --as bob\n  expect: text "Owner:" visible\n  covers: R1\n';
  const marks = "## Requirements\n- R2 (unchanged): the regular user's page stays as it is\n\n";
  // The reviewer's probe: re-marked, then "proven" with a positive check.
  const positive = `${marks}## Criteria\n${owner}- [C2] alice page still lists projects\n  proof: toolkit open --path /projects --as alice\n  expect: text "Projects" visible\n  covers: R2\n`;
  const reqs = withSpecMarks(intake, positive);
  const r = lintSpec(positive, { kind: "feature", toolkit: view, requirements: reqs });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /R2 says what must not happen/);
  // With the absence asserted it lints; it is a guard (must hold on the base, not counted as non-discriminating).
  const absent = `${marks}## Criteria\n${owner}- [C2] alice sees no owner\n  proof: toolkit open --path /projects --as alice\n  expect: text "Projects" visible and text "Owner:" not visible\n  covers: R2\n`;
  const ok = lintSpec(absent, { kind: "feature", toolkit: view, requirements: withSpecMarks(intake, absent) });
  assert.ok(ok.ok, ok.reason ?? "");
  assert.deepEqual(guardCriteria(ok.criteria, withSpecMarks(intake, absent)), ["C2"]);
  const held: BaseCheck = {
    head: "b",
    key: "k",
    results: [{ criterion: "C2", status: "pass", evidence: ["e1"], clauses: [{ clause: 'text "Owner:" not visible', pass: true, got: "" }] }],
    skipped: [],
    passing: [],
  };
  assert.deepEqual(baseNegativeProblems(ok.baseNegatives, held, ["C2"]), []);
  assert.deepEqual(guardBaseProblems(["C2"], held), []);
  const skipped: BaseCheck = { ...held, results: [], skipped: [{ criterion: "C2", why: "needs what the base doesn't have: x.y" }] };
  assert.match(baseNegativeProblems(ok.baseNegatives, skipped, ["C2"])[0] ?? "", /can't be checked on the base/, "it must still run on the base");
  // A security job: no re-mark.
  assert.deepEqual(withSpecMarks(intake, absent, { security: true }), intake);
  assert.match(remarkProblems(intake, absent, { security: true })[0] ?? "", /security surface/);
  assert.deepEqual(remarkProblems(intake, absent), []);
});

test("rule 3: a long literal must have the length the criterion states (b-control-long-title #2: 230 for 200)", () => {
  const cli = { ...toolkit, primitives: [...toolkit.primitives, "cli"] };
  const L = (text: string, n: number, expect = 'exit 0 and contains "Added task"') =>
    lintSpec(spec(C("C1", text, `toolkit cli --argv '["add","${"x".repeat(n)}"]'`, expect)), { kind: "feature", toolkit: cli });
  assert.match(L("A 200-character title is still accepted.", 230).reason ?? "", /says 200 characters.*\(230/);
  assert.ok(L("A 200-character title is still accepted.", 200).ok);
  assert.ok(L("A title longer than 200 characters is refused", 201).ok);
  assert.match(L("A title longer than 200 characters is refused", 200).reason ?? "", /longer than 200/);
  assert.ok(L("A title within the limit (max 200 characters) is accepted", 150).ok, "a bare limit states nothing about the literal");
  assert.ok(L("A short title is accepted", 230).ok, "no length stated");
});

test("probe: a repro may not pin the bug's outcome through a feature drive's expect_status either", () => {
  const view = { primitives: ["read", "http"], drives: { "orders.create": ["qty", "expect_status"] } };
  const md = spec(C("C1", "x", "toolkit orders.create --qty 100 --expect_status 400 ; toolkit read --target status --save code", '$code == "201"', true));
  assert.match(lintSpec(md, { kind: "bug", toolkit: view }).reason ?? "", /pins an error outcome/);
});

test("rule 10: what the running app does is proven by driving it; a test the verifier writes is only for pure logic or next to a drive", () => {
  // Must refuse: job 001's shape, an HTTP route proven only by a test file the verifier writes.
  const refused: [string, string][] = [
    ["A member renewing their own loan gets 200 and POST /loans/:id/renew moves due_at 14 days", "test test/renew-extend.test.js"],
    ["A second renewal returns 409 with an error body", "test test/renew-once.test.js"],
    ["Pressing the Borrow button on the catalogue page borrows the book", "cmd node test/borrow.mjs"],
    ["`tasks done 3` prints the task as done and exits 0", "test test/done.test.js"],
  ];
  for (const [text, proof] of refused)
    assert.match(
      lint(spec(C("C1", text, proof, "exit 0"))).reason ?? "",
      /C1: it is about what the running app does .*must drive the app through the Toolkit/,
      text,
    );
  // Must pass: the same behaviour driven through the Toolkit, a test next to a drive, pure logic with a test.
  const passed = [
    C("C1", "A second renewal returns 409 with an error body", "toolkit http --method POST --path /loans/1/renew --as alice --save r", '$r_status == "409"'),
    C("C2", "GET /loans shows the renewed due date", "toolkit http --method GET --path /loans --as alice --save l", 'json $l[0].due_at == "2025-01-30"'),
    C("C5", "The renewal rule's unit tests hold (an extra check next to C1 and C2)", "test test/renew.test.js", "exit 0"),
    C("C3", "addDays adds whole days across a month end", "test test/dates.test.js", "exit 0"),
    C("C4", "package.json lists react and react-dom as dependencies", 'cmd node -e "process.exit(0)"', "exit 0"),
  ];
  assert.equal(lint(spec(...passed)).reason, undefined);
  // Without a Toolkit (ADR 0010) checks and tests are all there is: not refused.
  assert.equal(lintSpec(spec(C("C1", refused[0][0], refused[0][1], "exit 0")), { kind: "feature", toolkit, noToolkit: true }).ok, true);
});
