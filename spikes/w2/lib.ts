// Shared helpers for the W2 spikes: a fixture copied into a throwaway git repo
// (its hand-made Toolkit optionally removed), the real `kitchen` CLI run as a
// child process, PASS/FAIL lines, and a Docker check that nothing of ours is left.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const CLI = path.join(ROOT, "src", "cli.ts");

let fails = 0;
let passes = 0;
export function check(name: string, ok: boolean, evidence = "") {
  if (ok) passes++;
  else fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${evidence ? `: ${evidence}` : ""}`);
  return ok;
}
export function finish(label: string) {
  console.log(`\n${label}: ${passes} passed, ${fails} failed`);
  process.exitCode = fails ? 1 : 0;
}

export const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=spike", "-c", "user.email=s@example.invalid", ...a], { cwd, stdio: "pipe" }).toString().trim();

export type Repo = { dir: string; home: string; env: NodeJS.ProcessEnv };

/**
 * fixtures/<name> → <root>/<label>, a fresh git repo with one commit. `fresh`
 * drops a hand-made Toolkit (.kitchen/toolkit, .env.kitchen) so init must make one.
 */
export function fixtureRepo(root: string, name: string, label: string, o: { fresh?: boolean; yaml?: string } = {}): Repo {
  const dir = path.join(root, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ROOT, "fixtures", name), dir, {
    recursive: true,
    filter: (src) => !/(^|\/)(node_modules|__pycache__|\.kitchen-out|data)(\/|$)/.test(path.relative(path.join(ROOT, "fixtures", name), src)),
  });
  if (o.fresh) {
    fs.rmSync(path.join(dir, ".kitchen"), { recursive: true, force: true });
    fs.rmSync(path.join(dir, ".env.kitchen"), { force: true });
  }
  if (o.yaml) fs.writeFileSync(path.join(dir, "kitchen.yaml"), o.yaml);
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `fixture ${name}`);
  const home = path.join(root, "kitchen-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return { dir, home, env: { ...process.env, KITCHEN_HOME: home, KITCHEN_TICK_MS: "200" } };
}

/** `kitchen <args> --repo <dir>`, stdin not a TTY. */
export function kitchen(r: Repo, args: string[], o: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): { out: string; code: number } {
  const p = spawnSync(process.execPath, [CLI, ...args, "--repo", r.dir], {
    env: { ...r.env, ...(o.env ?? {}) },
    encoding: "utf8",
    timeout: o.timeoutMs ?? 600_000,
    stdio: ["pipe", "pipe", "pipe"],
    input: "",
  });
  const out = `${p.stdout}${p.stderr}`;
  if (process.env.W2_VERBOSE) process.stdout.write(out.replace(/^/gm, `    [${args[0]}] `));
  return { out, code: p.status ?? -1 };
}

/** The same, streaming every line to our stdout as it comes (long agent runs). */
export function kitchenLive(r: Repo, args: string[], o: { env?: NodeJS.ProcessEnv; logFile?: string } = {}): Promise<{ out: string; code: number; secs: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, "--repo", r.dir], { env: { ...r.env, ...(o.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const on = (b: Buffer) => {
      const s = b.toString();
      out += s;
      process.stdout.write(s.replace(/^(?=.)/gm, "    "));
      if (o.logFile) fs.appendFileSync(o.logFile, s);
    };
    p.stdout.on("data", on);
    p.stderr.on("data", on);
    p.on("close", (code) => resolve({ out, code: code ?? -1, secs: (Date.now() - t0) / 1000 }));
  });
}

/** Containers and slots this spike's Toolkits may have left (by Kitchen's labels/prefixes). */
export function ourContainers(): string[] {
  const r = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
  return (r.stdout || "")
    .split("\n")
    .filter((n) => /^kitchen[-_]/.test(n));
}

export const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(f, "utf8")) as T;
