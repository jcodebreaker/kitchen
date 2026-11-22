import assert from "node:assert/strict";
import { test } from "vitest";
import { loadRegistry } from "./registry.ts";
import { type JobFacts, selectSkills, ticketSkills } from "./select.ts";

const reg = loadRegistry();
const facts = (f: Partial<JobFacts> = {}): JobFacts => ({ kind: "feature", surfaces: [], risk: "medium", ticket: "Add a count.", ...f });
const names = (role: string, f: Partial<JobFacts> = {}) => selectSkills(reg, role, facts(f)).wants.map((w) => `${w.name}:${w.need}`);

test("the builder's skills follow the ticket's kind", () => {
  assert.deepEqual(names("builder", { kind: "bug" }), ["diagnosing-bugs:optional"]);
  assert.deepEqual(names("builder", { kind: "feature" }), ["tdd:optional"]);
  assert.deepEqual(names("builder", { kind: "ui" }), ["tdd:optional"]);
  assert.deepEqual(names("builder", { kind: "chore" }), ["codebase-design:optional"], "refactor and tech-debt are chores");
  assert.deepEqual(names("builder", { kind: null }), [], "before intake rates the kind");
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

test("Kitchen-Skills: adds registry skills (required) to the builder only, outside code fences; others are refused, never halted on", () => {
  const ticket = [
    "Fix the overdue count.",
    "Skills: TypeScript, React",
    "Kitchen-Skills: codebase-design, `prototype`",
    "```",
    "Kitchen-Skills: humanizer",
    "```",
    "~~~md",
    "kitchen-skills: impeccable",
    "~~~",
    "- **Kitchen-Skills:** grilling, mattpocock-skills:tdd, ../../etc/passwd",
  ].join("\n");
  assert.deepEqual(
    ticketSkills(ticket),
    ["codebase-design", "prototype", "grilling", "mattpocock-skills:tdd", "../../etc/passwd"],
    "a plain Skills: line is not ours",
  );
  const s = selectSkills(reg, "builder", facts({ kind: "bug", ticket }));
  assert.deepEqual(
    s.wants.map((w) => `${w.name}:${w.need}`),
    ["diagnosing-bugs:optional", "codebase-design:required"],
  );
  assert.deepEqual(
    s.refused.map((r) => r.name),
    ["prototype", "grilling", "mattpocock-skills:tdd", "../../etc/passwd"],
  );
  assert.match(s.refused[0].why, /not in Kitchen's skills registry/);
  assert.match(s.refused[1].why, /interactive/);
  assert.deepEqual(names("reviewer-code", { ticket }), ["code-review:optional", "codebase-design:optional"], "only the builder reads the line");
});
