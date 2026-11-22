// Shared helpers for the W3b spikes: the gh shim on PATH (gh-shim.mjs, recording
// every call), a local bare remote standing in for GitHub's git, and readers for
// the shim's state. Builds on spikes/w3a/lib.ts (fixture repos, the kitchen CLI).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixtureRepo, type Repo } from "../w3a/lib.ts";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHIM = path.join(HERE, "gh-shim.mjs");
export const SLUG = "acme/fixture";

export const sh = (cwd: string, cmd: string, ...a: string[]) =>
  execFileSync(cmd, a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
export const git = (cwd: string, ...a: string[]) => sh(cwd, "git", "-c", "user.name=human", "-c", "user.email=h@example.invalid", ...a);

export type Shim = { dir: string; bin: string; env: Record<string, string> };

/** A bin folder with `gh` → gh-shim.mjs, and its state folder. */
export function makeShim(root: string): Shim {
  const dir = path.join(root, "gh-state");
  const bin = path.join(root, "gh-bin");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  fs.writeFileSync(gh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SHIM)} "$@"\n`, { mode: 0o755 });
  return {
    dir,
    bin,
    env: { GH_SHIM_STATE: dir, KITCHEN_GH_BIN: gh, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "ghp_FAKEENGINETOKEN0000000000000000000000" },
  };
}

export type ShimState = {
  next: number;
  prs: {
    number: number;
    head: string;
    base: string;
    title: string;
    body: string;
    state: string;
    isDraft: boolean;
    labels: string[];
    checks: { name: string; bucket: string }[];
    comments: { body: string; user: string; created_at: string }[];
  }[];
  issues: {
    number: number;
    title: string;
    body: string;
    state: string;
    author: string;
    labels: string[];
    comments: { body: string; user: string; created_at: string }[];
    lastEditedAt?: string;
    events?: { type: string; at: string; label?: string }[];
  }[];
  labels: string[];
  defaultChecks: { name: string; bucket: string }[];
};
export const shimState = (s: Shim): ShimState =>
  fs.existsSync(path.join(s.dir, "state.json"))
    ? (JSON.parse(fs.readFileSync(path.join(s.dir, "state.json"), "utf8")) as ShimState)
    : { next: 1, prs: [], issues: [], labels: [], defaultChecks: [] };
export function editShim(s: Shim, fn: (st: ShimState) => void) {
  const st = shimState(s);
  fn(st);
  fs.writeFileSync(path.join(s.dir, "state.json"), JSON.stringify(st, null, 2));
}
export const shimCalls = (s: Shim): { argv: string[]; stdin: string; token: string }[] =>
  fs.existsSync(path.join(s.dir, "calls.jsonl"))
    ? fs
        .readFileSync(path.join(s.dir, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** A bare repo standing in for GitHub's git, with the fixture's main pushed. */
export function makeRemote(r: Repo): string {
  const bare = `${r.dir}.remote.git`;
  fs.rmSync(bare, { recursive: true, force: true });
  git(path.dirname(bare), "init", "-q", "--bare", "-b", "main", bare);
  git(r.dir, "push", "-q", bare, "main:main");
  return bare;
}

/** The "human" merges a branch on the remote (what clicking Merge on GitHub does): a merge commit on main. */
export function mergeOnRemote(bare: string, branch: string, scratch: string): string {
  const wt = path.join(scratch, `merge-${Date.now()}`);
  git(scratch, "clone", "-q", bare, wt);
  git(wt, "merge", "--no-ff", "-q", "-m", `Merge ${branch}`, `origin/${branch}`);
  git(wt, "push", "-q", "origin", "main");
  const sha = git(wt, "rev-parse", "HEAD").trim();
  fs.rmSync(wt, { recursive: true, force: true });
  return sha;
}

/** A commit straight onto the remote's main (someone else's merged PR). */
export function commitOnRemote(bare: string, scratch: string, file: string, edit: (text: string) => string, message: string): string {
  const wt = path.join(scratch, `push-${Date.now()}`);
  git(scratch, "clone", "-q", bare, wt);
  const f = path.join(wt, file);
  fs.writeFileSync(f, edit(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""));
  git(wt, "commit", "-qam", message);
  git(wt, "push", "-q", "origin", "main");
  const sha = git(wt, "rev-parse", "HEAD").trim();
  fs.rmSync(wt, { recursive: true, force: true });
  return sha;
}

/** A fixture A repo whose forge is "GitHub" (the shim + a bare remote). */
export function githubFixture(root: string, name: string, o: { agent: string; extra?: string; bug?: boolean }): { r: Repo; shim: Shim; bare: string } {
  const shim = makeShim(path.join(root, name));
  const yaml = `concurrency: 1
round_limit: 3
agent: ${o.agent}
checks:
  - { name: syntax, run: "node --check server.js" }
test_cmd: "node --test {file}"
forge: { kind: github, repo: ${SLUG}, url: "__REMOTE__", base: main }
${o.extra ?? ""}`;
  const r = makeFixtureRepo(path.join(root, name), "repo", { yaml, bug: o.bug });
  const bare = makeRemote(r);
  fs.writeFileSync(path.join(r.dir, "kitchen.yaml"), yaml.replace("__REMOTE__", bare));
  git(r.dir, "commit", "-qam", "kitchen.yaml: the remote");
  git(r.dir, "push", "-q", bare, "main:main");
  r.env = { ...r.env, ...shim.env };
  return { r, shim, bare };
}
