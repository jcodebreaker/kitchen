import { describe, expect, it } from "vitest";
import { baseArgs, filterDriversOf, NEUTRAL_CONFIG } from "./git.ts";

const repo = { gitDir: "/r/.git/worktrees/001", workTree: "/r/.worktrees/001" };

describe("baseArgs", () => {
  it("names the gitdir and work tree explicitly, before any command", () => {
    const a = baseArgs(repo);
    expect(a.slice(0, 3)).toEqual(["--git-dir=/r/.git/worktrees/001", "--work-tree=/r/.worktrees/001", "--no-pager"]);
    expect(a).not.toContain("-C");
  });
  it("neutralizes the keys that run programs", () => {
    const a = baseArgs(repo);
    for (const kv of ["core.fsmonitor=false", "core.hooksPath=/dev/null", "protocol.ext.allow=never", "credential.helper=", "core.sshCommand=false"]) {
      expect(NEUTRAL_CONFIG).toContain(kv);
      expect(a[a.indexOf(kv) - 1]).toBe("-c");
    }
  });
  it("empties every filter driver it is given", () => {
    const a = baseArgs(repo, ["lfs", "a.b"]);
    for (const k of ["filter.lfs.clean=", "filter.lfs.smudge=", "filter.lfs.process=", "filter.a.b.clean=", "filter.a.b.required=false"])
      expect(a).toContain(k);
  });
});

describe("filterDriversOf", () => {
  it("parses driver names, including dotted ones, once each", () => {
    expect(filterDriversOf("filter.lfs.clean\nfilter.lfs.smudge\nfilter.lfs.required\nfilter.a.b.process\n")).toEqual(["lfs", "a.b"]);
    expect(filterDriversOf("")).toEqual([]);
  });
});
