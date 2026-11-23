import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { personOnly } from "./deliver.ts";
import { README, registryTable, START, syncReadme } from "./readme.ts";
import { describeRule, installHint, isForbidden, loadRegistry, parseRegistry, REGISTRY_FILE, SKILLS_DIR } from "./registry.ts";

const raw = () => JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));

test("the shipped registry is valid and follows ADR 0014's table", () => {
  const r = loadRegistry();
  assert.deepEqual(r.roles["reviewer-security"].required, [{ skill: "security-review", risk: ["high"] }]);
  assert.equal(r.skills["security-review"].vendored, "vendor/security-review");
  assert.ok(r.roles.builder.ticket, "the ticket's Kitchen-Skills: line adds to the builder");
  assert.ok(!r.roles.intake.ticket);
  assert.ok(r.roles["reviewer-ui"].degraded);
  assert.ok(!r.skills.implement && !r.skills["to-spec"], "person-only skills are not in the registry");
  assert.deepEqual(r.roles.builder.optional, [], "codebase-design comes to the builder for chores only");
  for (const n of ["grilling", "wizard", "triage", "ask-matt"]) assert.ok(isForbidden(r, n), n);
  assert.ok(isForbidden(r, "mattpocock-skills:grilling"), "a plugin prefix doesn't hide an interactive skill");
  assert.match(installHint(r, "tdd", "claude"), /claude plugin install mattpocock-skills@claude-plugins-official/);
  assert.match(installHint(r, "unheard-of", "codex"), /~\/\.agents\/skills\/unheard-of\//);
  assert.equal(describeRule({ kind: ["feature", "ui"], risk: ["high"] }), "kind feature/ui, high risk");
});

test("every vendored skill ships as a model-invocable SKILL.md, credited in NOTICE", () => {
  const notice = fs.readFileSync(path.join(SKILLS_DIR, "..", "NOTICE"), "utf8");
  for (const [n, s] of Object.entries(loadRegistry().skills)) {
    if (!s.vendored) continue;
    const text = fs.readFileSync(path.join(SKILLS_DIR, s.vendored, "SKILL.md"), "utf8");
    assert.match(text, new RegExp(`^---\\nname: ${n}\\n`), n);
    assert.ok(!personOnly(text), n);
    assert.ok(!/^!`/m.test(text), `${n}: no bang command lines`);
    assert.match(text, /VERDICT: BLOCKING/, `${n}: speaks Kitchen's review contract`);
  }
  assert.match(notice, /claude-code-security-review[\s\S]*0c6a49f1fa56a1d472575da86a94dbc1edb78eda[\s\S]*Copyright \(c\) 2025 Anthropic/);
});

test("an invalid registry is refused with the path of the problem", () => {
  const bad = (edit: (r: ReturnType<typeof raw>) => void, msg: RegExp) => {
    const r = raw();
    edit(r);
    assert.throws(() => parseRegistry(JSON.stringify(r)), msg);
  };
  bad((r) => r.roles.intake.optional.push("grilling"), /roles\.intake: grilling is interactive/);
  bad((r) => r.roles.intake.optional.push("not-listed"), /not-listed is not listed under "skills"/);
  bad((r) => r.roles.builder.picked.push({ skill: "tdd" }), /a picked skill needs a kind, surface or risk/);
  bad((r) => r.roles.builder.picked.push({ skill: "tdd", kind: ["refactor"] }), /roles\.builder\.picked/);
  bad((r) => r.roles.intake.optional.push("../../etc"), /a skill name is/);
  bad((r) => Object.assign(r.roles.spec, { extra: 1 }), /roles\.spec/);
  bad((r) => Object.assign(r.skills.tdd, { source: "nowhere" }), /skills\.tdd: source nowhere/);
  bad((r) => Object.assign(r.skills["security-review"], { vendored: "../outside" }), /skills\.security-review\.vendored/);
  bad((r) => Object.assign(r.skills, { "p:x": { source: "local" } }), /skills\.p:x/);
  assert.throws(() => parseRegistry("{"), /skills\/registry\.json/);
});

test("the README's skills table is the one generated from the registry (npm run skills:readme)", () => {
  const text = fs.readFileSync(README, "utf8");
  assert.ok(text.includes(START));
  assert.equal(text, syncReadme(text, loadRegistry()), "README.md drifted from skills/registry.json: run npm run skills:readme");
  assert.match(registryTable(loadRegistry()), /\| reviewer-security \| `security-review` \(high risk\) \|/);
  assert.throws(() => syncReadme("no markers", loadRegistry()), /no <!-- skills-registry:start/);
});
