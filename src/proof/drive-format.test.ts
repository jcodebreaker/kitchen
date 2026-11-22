import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { checkPrimArgs, DriveFormatError, extractDriveBlocks, loadDrive, parseDrive, parseFlow, stripComment, substitute } from "./drive-format.ts";

test("flow values: nested mappings, lists, quotes, scalars", () => {
  assert.deepEqual(parseFlow(`{ until: { text: "Appearance" }, timeout: 10s }`), { until: { text: "Appearance" }, timeout: "10s" });
  assert.deepEqual(parseFlow(`{ target: "[aria-label='Dark mode']", attr: aria-checked }`), { target: "[aria-label='Dark mode']", attr: "aria-checked" });
  assert.deepEqual(parseFlow(`[user, slug]`), ["user", "slug"]);
  assert.deepEqual(parseFlow(`{ times: 2, on: fail, x: true }`), { times: 2, on: "fail", x: true });
  assert.deepEqual(parseFlow(`{ path: /api/me }`), { path: "/api/me" });
  assert.throws(() => parseFlow(`{ a: 1`), DriveFormatError);
  assert.throws(() => parseFlow(`{ a: 1, a: 2 }`), /duplicate/);
});

test("comments are stripped outside quotes only", () => {
  assert.equal(stripComment(`  - press: { target: "a#b" }   # reload`), `  - press: { target: "a#b" }`);
  assert.equal(stripComment(`# whole line`), "");
});

const SAMPLE = `drive: settings.toggle-dark
args: [user]
steps:
  - login: { as: $user }
  - wait:  { until: { text: "Appearance" }, timeout: 10s }
  - retry: { times: 2, on: fail }
  - read:  { target: body, attr: class }
    save: theme
  - type:  { target: "#x", text: "$theme!" }`;

test("parses the PLAN example shape into typed steps", () => {
  const d = parseDrive(SAMPLE);
  assert.equal(d.name, "settings.toggle-dark");
  assert.deepEqual(d.args, ["user"]);
  assert.deepEqual(
    d.steps.map((s) => s.kind),
    ["prim", "wait", "retry", "prim", "prim"],
  );
  assert.deepEqual(d.steps[1], { kind: "wait", text: "Appearance", target: "body", attr: undefined, timeoutMs: 10000, line: 5 });
  assert.deepEqual(d.steps[2], { kind: "retry", times: 2, line: 6 });
  assert.equal(d.steps[3].kind === "prim" && d.steps[3].save, "theme");
});

test("rejects what the format forbids", () => {
  const bad = (body: string, re: RegExp) => assert.throws(() => parseDrive(body), re);
  bad(`drive: x\nsteps:\n  - read: { target: a }\n    expect: dark`, /only save/);
  bad(`drive: x\nsteps:\n  - retry: { times: 2 }`, /retry must follow/);
  bad(`drive: x\nsteps:\n  - press: { target: $nope }`, /\$nope is not an arg/);
  bad(`drive: x\nsteps:\n  - wait: { until: { text: a }, timeout: soon }`, /wait/);
  bad(`drive: x\nloop: 3\nsteps:\n  - press: { target: a }`, /unknown top-level key/);
  bad(`drive: x\nsteps:\n  - wait: { until: { text: a } }\n    save: y`, /save: only follows a primitive/);
  bad(`drive: x\nsteps:`, /steps: empty/);
});

test("engine flags and flag-like names can't be passed by a step", () => {
  const bad = (step: string, re: RegExp) => assert.throws(() => parseDrive(`drive: x\nsteps:\n  - ${step}`), re);
  bad(`login: { as: bob-admin, id: p2 }`, /"id" is set by the engine/);
  bad(`screenshot: { name: s, out: /tmp/elsewhere }`, /"out" is set by the engine/);
  bad(`press: { target: a, src: /other }`, /"src" is set by the engine/);
  bad(`press: { target: a, ports: "1,2" }`, /"ports" is set by the engine/);
  bad(`press: { "--id": p2 }`, /must match/);
  bad(`press: { "-x": 1 }`, /must match/);
  bad(`press: { "a=b": 1 }`, /must match/);
  assert.throws(() => checkPrimArgs("read", { out: "/x" }), /set by the engine/);
  assert.throws(() => checkPrimArgs("--id=p2", {}), /not a primitive name/);
});

test("a wait with empty text is refused", () => {
  assert.throws(() => parseDrive(`drive: x\nsteps:\n  - wait: { until: { text: "" } }`), /non-empty text/);
});

test("a saved var is usable only after the step that saves it", () => {
  assert.throws(() => parseDrive(`drive: x\nsteps:\n  - type: { target: a, text: $v }\n  - read: { target: b }\n    save: v`), /\$v is not/);
});

test("substitute replaces whole and embedded vars and refuses unknown ones", () => {
  assert.deepEqual(substitute({ a: "$x", b: "pre $x post", c: 3 }, { x: "1" }), { a: "1", b: "pre 1 post", c: 3 });
  assert.throws(() => substitute("$y", {}), /no value/);
});

test("extracts drive blocks from markdown and reports line numbers", () => {
  const md = `# T\n\ntext\n\n\`\`\`drive\n${SAMPLE}\n\`\`\`\n`;
  const blocks = extractDriveBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].line, 6);
  assert.throws(() => loadDrive(`\`\`\`drive\ndrive: x\nsteps:\n  - bad line\n\`\`\``), /line 4/);
});

test("the fixture's three feature drives parse", () => {
  const dir = path.resolve(import.meta.dirname, "../../fixtures/a-web/.kitchen/toolkit/features");
  const names = ["settings.md", "projects.md", "invites.md"].map((f) => loadDrive(fs.readFileSync(path.join(dir, f), "utf8")).name);
  assert.deepEqual(names, ["settings.toggle-dark", "projects.create", "invites.generate-and-join"]);
});
