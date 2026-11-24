// The feature map as data (ADR 0017): the contract, `Code:` matching, the sweep order, and the weakening rule over
// the markdown structure (removed sub-feature, removed step, changed expected result; what CHANGES: allows).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { codeMatches, contractProblems, namedBy, parseFeature, readMap, removals, sweepOrder, touchedFeatures } from "./map.ts";

const SEARCH = `# Search books

A person finds books by part of the title or the author.

## Sub-features

- \`search-match\` finds books by title or author, ignoring case.
- \`search-clear\` shows every book again when the box is emptied.

## How to get to it (user POV)

- On \`/\`, the Search box (\`#book-search\`) above the Books table.

## Driving it with kitchen qa

Preconditions:

- The app is up on seed data (\`kitchen qa reset <id>\`).

- **Author match.** Type \`tolkien\` in \`#book-search\`. Run \`kitchen qa page <id> / --name search-author --script s.mjs\`. Only The Hobbit and The Fellowship of the Ring remain.
- **Clear.** Empty the box (\`search-clear\`). Run \`kitchen qa page <id> / --name search-clear --script c.mjs\`. All 6 books are listed.

## Gotchas

- The list follows the box as you type.

Code: \`public/app.js\`, \`server.js\`
`;

test("a pstack-shaped feature file: sub-feature ids, steps keyed by label, expected results, Code: paths; the contract holds", () => {
  const f = parseFeature("search", SEARCH);
  assert.equal(f.title, "Search books");
  assert.deepEqual(
    f.subs.map((s) => s.id),
    ["search-match", "search-clear"],
  );
  assert.deepEqual(
    f.steps.map((s) => s.label),
    ["Author match", "Clear"],
    "the Preconditions list is not a step",
  );
  assert.equal(f.steps[0].expected, "Only The Hobbit and The Fellowship of the Ring remain");
  assert.deepEqual(f.steps[1].subs, ["search-clear"], "a step names the sub-feature it proves");
  assert.deepEqual(f.code, ["public/app.js", "server.js"]);
  assert.deepEqual(contractProblems(f), []);
  // pstack's own reference file reads the same way.
  const pst = path.join(
    os.homedir(),
    ".claude/plugins/cache/cursor-plugins/pstack/0.15.46/skills/create-verification-skill/references/feature-map-example/search.md",
  );
  if (fs.existsSync(pst)) {
    const p = parseFeature("search", fs.readFileSync(pst, "utf8"));
    assert.equal(p.subs[0].id, "search-open");
    assert.equal(p.steps[0].label, "Toolbar entry");
    assert.match(p.steps[0].expected, /dialog named `?Search notes/);
    assert.deepEqual(contractProblems(p), ["a last `Code:` line naming the files or folders behind the feature"], "pstack has no Code: line");
  }
});

test("the contract: four H2s in order, sub-features, steps and a Code: line", () => {
  const swapped = SEARCH.replace("## Gotchas", "## Notes");
  assert.match(contractProblems(parseFeature("x", swapped)).join(), /exactly four H2s/);
  assert.match(contractProblems(parseFeature("x", SEARCH.replace(/Code:.*\n/, ""))).join(), /Code:/);
  assert.match(contractProblems(parseFeature("x", SEARCH.replace(/- \*\*Author[^\n]*\n- \*\*Clear[^\n]*\n/, ""))).join(), /recipe step/);
});

test("Code: matching: a file, a folder, a glob; the touched features in map order", () => {
  assert.ok(codeMatches("public/app.js", "public/app.js"));
  assert.ok(!codeMatches("public/app.js", "public/app.json"));
  assert.ok(codeMatches("lib/", "lib/loans.js"));
  assert.ok(codeMatches("lib", "lib/x/y.js"));
  assert.ok(!codeMatches("lib", "library.js"));
  assert.ok(codeMatches("src/**/*.tsx", "src/a/b/Page.tsx"));
  const loans = parseFeature("loans", SEARCH.replace("Code: `public/app.js`, `server.js`", "Code: `lib/loans.js`"));
  const search = parseFeature("search", SEARCH);
  assert.deepEqual(
    touchedFeatures([loans, search], ["public/app.js", "README.md"]).map((f) => f.id),
    ["search"],
  );
  assert.deepEqual(touchedFeatures([loans, search], ["README.md"]), []);
});

test("the sweep order is the README's links, then the rest by name", () => {
  const fs3 = ["a", "b", "c"].map((id) => parseFeature(id, SEARCH));
  assert.deepEqual(
    sweepOrder("## Features\n- [C](./c.md): c\n- [A](a.md): a\n", fs3).map((f) => f.id),
    ["c", "a", "b"],
  );
});

test("the weakening rule: removed sub-feature, removed step, changed expected result; CHANGES names what may go", () => {
  const before = [parseFeature("search", SEARCH)];
  assert.deepEqual(removals(before, before), [], "the same map removes nothing");
  // Adding is never a removal; whitespace in an expected result doesn't count.
  const more = SEARCH.replace("- `search-clear`", "- `search-api` answers GET /books?q=.\n- `search-clear`").replace(
    "All 6 books are listed.",
    "All 6  books are listed.\n- **API.** Run `kitchen qa http <id> GET /books?q=x --name a`. 200.",
  );
  assert.deepEqual(removals(before, [parseFeature("search", more)]), []);

  const noSub = SEARCH.replace(/- `search-clear`[^\n]*\n/, "");
  const r1 = removals(before, [parseFeature("search", noSub)]);
  assert.deepEqual(
    r1.map((r) => [r.kind, r.item]),
    [["sub", "search/search-clear"]],
  );

  const looser = SEARCH.replace("Only The Hobbit and The Fellowship of the Ring remain.", "Some rows remain.");
  const r2 = removals(before, [parseFeature("search", looser)]);
  assert.deepEqual(
    r2.map((r) => [r.kind, r.item, r.was, r.now]),
    [["expected", "search: Author match", "Only The Hobbit and The Fellowship of the Ring remain", "Some rows remain"]],
  );

  const noStep = SEARCH.replace(/- \*\*Clear\.\*\*[^\n]*\n/, "");
  const r3 = removals(before, [parseFeature("search", noStep)]);
  assert.deepEqual(
    r3.map((r) => [r.kind, r.subs]),
    [["step", ["search-clear"]]],
  );
  assert.equal(removals(before, []).length, 4, "a feature file gone removes its 2 sub-features and 2 steps");

  // CHANGES: the sub-feature itself; a step that names a sub-feature needs that one; a step naming none, any of its feature.
  assert.equal(namedBy(r1[0], ["search/search-clear"]), "search/search-clear");
  assert.equal(namedBy(r1[0], ["search/search-match"]), null);
  assert.equal(namedBy(r3[0], ["search/search-match"]), null, "the Clear step proves search-clear");
  assert.equal(namedBy(r3[0], ["Search/Search-Clear"]), "Search/Search-Clear", "ids compare without case");
  assert.equal(namedBy(r2[0], ["search/search-match"]), "search/search-match", "Author match names no sub-feature: any of search's");
  assert.equal(namedBy(r2[0], ["loans/loans-list"]), null);
});

test("readMap finds the skill in a checkout (the Claude copy first) and reads its features", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-map-"));
  const d = path.join(root, ".agents/skills/verify-app/features");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, ".agents/skills/verify-app/SKILL.md"), "x");
  fs.writeFileSync(path.join(d, "README.md"), "# map\n");
  fs.writeFileSync(path.join(d, "search.md"), SEARCH);
  const m = readMap(root);
  assert.equal(m.name, "verify-app");
  assert.deepEqual(
    m.features.map((f) => f.id),
    ["search"],
  );
  assert.equal(readMap(path.join(root, "nope")).name, null);
  fs.rmSync(root, { recursive: true, force: true });
});
