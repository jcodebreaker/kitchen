import assert from "node:assert/strict";
import { test } from "vitest";
import { ExpectError, evaluate, needsPage, type Outcome, parseExpect, varsOf } from "./assert.ts";
import { ProofLineError, parseProof } from "./proof-line.ts";

const o = (x: Partial<Outcome> = {}): Outcome => ({ ok: true, exit: 0, output: "", vars: {}, ...x });
const check = (expect: string, out: Outcome) => evaluate(parseExpect(expect), out);

test("text visible / not visible reads the page body", () => {
  assert.equal(check('text "Saved" visible', o({ pageText: "Settings Saved" })).pass, true);
  assert.equal(check('text "Saved" visible', o({ pageText: "Saving…" })).pass, false);
  assert.equal(check('text "Error" not visible', o({ pageText: "fine" })).pass, true);
  assert.equal(check('text "Saved" visible', o()).pass, false, "no page text read: never passes");
  assert.ok(needsPage(parseExpect('text "x" visible')));
  assert.ok(!needsPage(parseExpect('contains "x"')));
});

test("contains, exit code, ok", () => {
  assert.equal(check('contains "theme-dark"', o({ output: "theme-dark big" })).pass, true);
  assert.equal(check('not contains "theme-dark"', o({ output: "theme-dark" })).pass, false);
  assert.equal(check("exit 0", o({ exit: 0 })).pass, true);
  assert.equal(check("exit code 1", o({ exit: 1 })).pass, true);
  assert.equal(check("exit != 0", o({ exit: 0 })).pass, false);
  assert.equal(check("ok", o({ ok: false, exit: 1 })).pass, false);
});

test("json paths into the output or a saved var", () => {
  const me = JSON.stringify({ status: 200, body: { username: "alice", theme: "dark", tags: ["a", "b"] } });
  assert.equal(check('json $me.body.theme == "dark"', o({ vars: { me } })).pass, true);
  assert.equal(check('json $me.body.tags[1] == "b"', o({ vars: { me } })).pass, true);
  assert.equal(check('json .body.username != "bob"', o({ output: me })).pass, true);
  assert.equal(check("json .status == 200", o({ output: me })).pass, true);
  assert.equal(check('json .body contains "dark"', o({ output: me })).pass, true);
  const r = check('json $me.body.theme == "light"', o({ vars: { me } }));
  assert.equal(r.pass, false);
  assert.match(r.why ?? "", /got "dark"/);
  assert.match(check('json .a == "x"', o({ output: "not json" })).why ?? "", /not JSON/);
  assert.match(check('json $nope.a == "x"', o()).why ?? "", /\$nope was not saved/);
});

test("row counts", () => {
  assert.equal(check("rows == 3", o({ output: "[1,2,3]" })).pass, true);
  assert.equal(check("row count 2", o({ output: '{"rows":[1,2]}' })).pass, true);
  assert.equal(check("rows $list >= 1", o({ vars: { list: '{"body":[{"a":1}]}' } })).pass, true);
  assert.equal(check("rows 2", o({ output: "a\n\nb\n" })).pass, true, "plain lines");
  assert.equal(check("rows > 5", o({ output: "[1]" })).pass, false);
});

test("$var comparisons, and clauses joined with and", () => {
  assert.equal(check('$theme == "Dark"', o({ vars: { theme: "Dark" } })).pass, true);
  assert.equal(check('$theme != "Light"', o({ vars: { theme: "Dark" } })).pass, true);
  assert.equal(check('$me contains "dark"', o({ vars: { me: '{"theme":"dark"}' } })).pass, true);
  assert.equal(check('$theme == "Dark" and $before == "false"', o({ vars: { theme: "Dark", before: "false" } })).pass, true);
  const r = check('$theme == "Dark" and $before == "true"', o({ vars: { theme: "Dark", before: "false" } }));
  assert.equal(r.pass, false);
  assert.equal(r.results.length, 2);
  assert.equal(check('$x == "a and b"', o({ vars: { x: "a and b" } })).pass, true, "and inside quotes is text");
  assert.equal(check("$n == 3", o({ vars: { n: "3" } })).pass, true, "numbers compare with saved text");
  assert.deepEqual(varsOf(parseExpect('$a == "x" and json $b.c == 1 and rows $d 2')), ["a", "b", "d"]);
});

test("anything else is refused, judged is not mechanical", () => {
  for (const bad of ["judged", "", "looks right", "text Saved visible", 'text "" visible', "exit zero", '$x === "a"', 'json theme == "a"', "$x == Dark"])
    assert.throws(() => parseExpect(bad), ExpectError, bad);
});

test("proof lines: toolkit segments, cmd, test", () => {
  assert.deepEqual(parseProof("toolkit settings.toggle-dark --user alice ; toolkit read --target body --attr=class"), [
    { kind: "toolkit", name: "settings.toggle-dark", args: { user: "alice" }, drive: true },
    { kind: "toolkit", name: "read", args: { target: "body", attr: "class" }, drive: false },
  ]);
  assert.deepEqual(parseProof("toolkit read --target \"[aria-label='Dark mode']\""), [
    { kind: "toolkit", name: "read", args: { target: "[aria-label='Dark mode']" }, drive: false },
  ]);
  assert.deepEqual(parseProof("cmd node --check server.js ; echo hi"), [{ kind: "cmd", cmd: "node --check server.js ; echo hi" }]);
  assert.deepEqual(parseProof("test test/theme.test.js"), [{ kind: "test", file: "test/theme.test.js" }]);
  for (const bad of [
    "run foo",
    "toolkit",
    "toolkit read target",
    "toolkit read --target",
    "toolkit read --a 1 --a 2",
    "toolkit x ; cmd ls",
    'toolkit read --t "x',
  ])
    assert.throws(() => parseProof(bad), ProofLineError, bad);
  assert.deepEqual(
    parseProof("toolkit login --as alice ; open --path /home").map((s) => (s.kind === "toolkit" ? s.name : s.kind)),
    ["login", "open"],
    "later segments may leave out the word toolkit",
  );
});
