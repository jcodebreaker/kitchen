import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "vitest";
import { README, registryTable, START, syncReadme } from "./readme.ts";
import { installHint, isForbidden, loadRegistry, parseRegistry, REGISTRY_FILE } from "./registry.ts";

const raw = () => JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));

test("the shipped registry is valid and follows ADR 0014's table", () => {
  const r = loadRegistry();
  assert.deepEqual(r.roles["reviewer-security"].required, [{ skill: "security-review", risk: ["high"] }]);
  assert.ok(r.roles.builder.ticket, "the ticket's Skills: line adds to the builder");
  assert.ok(!r.roles.intake.ticket);
  assert.ok(r.roles["reviewer-ui"].degraded);
  for (const n of ["grilling", "wizard", "triage", "ask-matt"]) assert.ok(isForbidden(r, n), n);
  assert.ok(isForbidden(r, "mattpocock-skills:grilling"), "a plugin prefix doesn't hide an interactive skill");
  assert.match(installHint(r, "tdd", "claude"), /claude plugin install mattpocock-skills@claude-plugins-official/);
  assert.match(installHint(r, "unheard-of", "codex"), /~\/\.agents\/skills\/unheard-of\//);
});

test("an invalid registry is refused with the path of the problem", () => {
  const bad = (edit: (r: ReturnType<typeof raw>) => void, msg: RegExp) => {
    const r = raw();
    edit(r);
    assert.throws(() => parseRegistry(JSON.stringify(r)), msg);
  };
  bad((r) => r.roles.builder.optional.push("grilling"), /roles\.builder: grilling is interactive/);
  bad((r) => r.roles.builder.optional.push("not-listed"), /not-listed is not listed under "skills"/);
  bad((r) => r.roles.builder.picked.push({ skill: "tdd" }), /a picked skill needs a kind, surface or risk/);
  bad((r) => r.roles.builder.picked.push({ skill: "tdd", kind: ["refactor"] }), /roles\.builder\.picked/);
  bad((r) => r.roles.builder.optional.push("../../etc"), /a skill name is/);
  bad((r) => Object.assign(r.roles.spec, { extra: 1 }), /roles\.spec/);
  bad((r) => Object.assign(r.skills.tdd, { source: "nowhere" }), /skills\.tdd: source nowhere/);
  assert.throws(() => parseRegistry("{"), /skills\/registry\.json/);
});

test("the README's skills table is the one generated from the registry (npm run skills:readme)", () => {
  const text = fs.readFileSync(README, "utf8");
  assert.ok(text.includes(START));
  assert.equal(text, syncReadme(text, loadRegistry()), "README.md drifted from skills/registry.json: run npm run skills:readme");
  assert.match(registryTable(loadRegistry()), /\| reviewer-security \| `security-review` \(high risk\) \|/);
  assert.throws(() => syncReadme("no markers", loadRegistry()), /no <!-- skills-registry:start/);
});
