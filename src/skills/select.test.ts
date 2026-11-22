import assert from "node:assert/strict";
import { test } from "vitest";
import { loadRegistry } from "./registry.ts";
import { type JobFacts, selectSkills, ticketSkills } from "./select.ts";

const reg = loadRegistry();
const facts = (f: Partial<JobFacts> = {}): JobFacts => ({ kind: "feature", surfaces: [], risk: "medium", ticket: "Add a count.", ...f });
const names = (role: string, f: Partial<JobFacts> = {}) => selectSkills(reg, role, facts(f)).wants.map((w) => `${w.name}:${w.need}`);

test("the builder's skills follow the ticket's kind", () => {
  assert.deepEqual(names("builder", { kind: "bug" }), ["diagnosing-bugs:optional", "codebase-design:optional"]);
  assert.deepEqual(names("builder", { kind: "feature" }), ["tdd:optional", "implement:optional", "codebase-design:optional"]);
  assert.deepEqual(names("builder", { kind: "ui" }), ["tdd:optional", "implement:optional", "codebase-design:optional"]);
  assert.deepEqual(names("builder", { kind: "chore" }), ["codebase-design:optional"], "picked and optional: listed once");
  assert.deepEqual(names("builder", { kind: null }), ["codebase-design:optional"], "before intake rates the kind");
});

test("security-review is required at high risk, picked for the security surface; impeccable for the ui surface", () => {
  assert.deepEqual(names("reviewer-security", { risk: "high" }), ["security-review:required"]);
  assert.deepEqual(names("reviewer-security", { risk: "medium", surfaces: ["security"] }), ["security-review:optional"]);
  assert.deepEqual(names("reviewer-security", { risk: "high", surfaces: ["security"] }), ["security-review:required"], "required wins");
  assert.deepEqual(names("reviewer-security", { risk: "low" }), []);
  assert.deepEqual(names("reviewer-ui", { surfaces: ["ui"] }), ["impeccable:optional"]);
  assert.deepEqual(names("reviewer-ui", { surfaces: [] }), []);
  assert.deepEqual(names("verifier"), []);
  assert.deepEqual(names("smith"), [], "a role the registry doesn't list loads nothing");
});

test("a ticket's Skills: line adds required skills to the builder only, outside code fences; interactive ones are refused", () => {
  const ticket = [
    "Fix the overdue count.",
    "Skills: diagnosing-bugs, `mattpocock-skills:prototype`",
    "```",
    "Skills: wizard",
    "```",
    "~~~md",
    "skills: in-a-fence",
    "~~~",
    "- **Skills:** grilling, ../../etc/passwd",
  ].join("\n");
  assert.deepEqual(ticketSkills(ticket), ["diagnosing-bugs", "mattpocock-skills:prototype", "grilling", "../../etc/passwd"]);
  const s = selectSkills(reg, "builder", facts({ kind: "bug", ticket }));
  assert.deepEqual(
    s.wants.map((w) => `${w.name}:${w.need}`),
    ["diagnosing-bugs:required", "codebase-design:optional", "mattpocock-skills:prototype:required"],
    "the ticket only adds (and can make a picked skill required)",
  );
  assert.deepEqual(
    s.refused.map((r) => r.name),
    ["grilling", "../../etc/passwd"],
  );
  assert.deepEqual(names("reviewer-code", { ticket }), ["code-review:optional", "codebase-design:optional"], "only the builder reads the line");
});
