import assert from "node:assert/strict";
import { test } from "vitest";
import { parseProof } from "../proof/proof-line.ts";
import { changedExistingDrive, lintFeatureFile } from "./feature-lint.ts";
import { gateOutcome } from "./gate.ts";
import { riskFloor, seedTouched } from "./risk-floor.ts";
import { lintSpec, newDrivesOf, parseRequirements } from "./spec-lint.ts";

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

test("rule 3: a negative expect needs an earlier step of the same proof that creates what must not show", () => {
  const leak = "toolkit login --as alice ; toolkit open --path /projects";
  assert.match(
    lint(spec(C("C1", "Alice doesn't see Bob's project", leak, 'text "Bob plan" not visible'))).reason ?? "",
    /holds whenever the thing never existed/,
  );
  const made = `${spec(
    C(
      "C1",
      "Alice doesn't see Bob's project",
      'toolkit projects.make --user bob-admin --name "Bob plan" ; toolkit login --as alice ; toolkit open --path /projects',
      'text "Bob plan" not visible and text "Onboarding" visible',
    ),
  )}\n## New drives\n- projects.make: sign in as user, create a project named name\n`;
  assert.equal(lint(made).reason, undefined, "created by an earlier step");
  assert.match(lint(spec(C("C1", "x", "toolkit settings.toggle-dark --user alice", '$theme != "Light"'))).reason ?? "", /never existed/);
  assert.match(lint(spec(C("C1", "x", leak, 'not contains "secret"'))).reason ?? "", /never existed/);
  assert.ok(lint(spec(C("C1", "x", "cmd node --check server.js", "exit != 1"))).ok, "an exit code is not a negative expect");
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
