import assert from "node:assert/strict";
import { test } from "vitest";
import { proofProfileText } from "./sandbox.ts";

test("proof profile: no network but loopback, home unreadable but the worktree and toolchains, credentials and KITCHEN_HOME denied last", () => {
  const p = proofProfileText({
    worktree: "/h/repo/.worktrees/001-x",
    home: "/h",
    kHome: "/k",
    tmp: "/t",
    pathEnv: "/h/.nvm/versions/node/v22/bin:/usr/bin:relative",
    deny: ["/h/repo/.kitchen/jobs"],
  });
  const lines = p.split("\n");
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  assert.ok(at(/^\(deny network\*\)$/) > 0);
  assert.ok(!/allow network\* \(local/.test(p), "an outbound socket matches `local ip`: only bind/inbound may use it");
  assert.match(p, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  const write = lines[at(/^\(allow file-write\*/)];
  assert.match(write, /"\/h\/repo\/\.worktrees\/001-x"/);
  assert.match(write, /\(subpath "\/t"\)/, "the run's own TMPDIR");
  assert.ok(!/\/private\/tmp|\/private\/var\/folders/.test(write), "not temp as a whole: another job's worktree may live there");
  assert.match(lines[at(/^\(deny file-read\* \(subpath "\/h"\)\)/)], /\/h/);
  const allowRead = lines[at(/^\(allow file-read\* \(literal/)];
  assert.match(allowRead, /\(subpath "\/h\/\.nvm\/versions\/node\/v22"\)/, "a toolchain on PATH under home stays readable");
  assert.match(allowRead, /\(literal "\/h\/repo\/package\.json"\)/, "package.json above the worktree (node's lookup)");
  const deny = at(/^\(deny file-read\* file-write\*/);
  assert.ok(deny > at(/^\(allow file-read\* \(literal/), "the credential deny comes after the allows: last match wins");
  for (const d of ['"/k"', '"/h/.ssh"', '"/h/.claude"', '"/h/repo/.kitchen/jobs"']) assert.ok(lines[deny].includes(d), d);
});

test("checks_network: outbound network allowed, the filesystem rules unchanged", () => {
  const o = { worktree: "/h/repo/.worktrees/001-x", home: "/h", kHome: "/k", tmp: "/t" };
  const off = proofProfileText(o);
  const on = proofProfileText({ ...o, network: true });
  assert.ok(!/network/.test(on.split("\n").slice(2).join("\n")), "no network rule at all");
  const fsRules = (p: string) => p.split("\n").filter((l) => /file-/.test(l));
  assert.deepEqual(fsRules(on), fsRules(off));
});
