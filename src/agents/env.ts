// The scrubbed environments (PLAN §3, ADR 0006).
// Built from an allowlist, never by deleting from the parent env: anything not
// named here (GH_TOKEN, cloud keys, SSH_AUTH_SOCK, ...) never reaches the child.
//
// Two flavours share the allowlist and the git/gh scrub:
// - agentEnv: a coding agent (Claude Code, Codex). Adds the agent tool's own auth.
// - untrustedEnv: every process that runs worktree code (the app, tests, cmd
//   proofs, Toolkit primitives). No agent auth; adds the worktree's
//   `.env.kitchen` (fake values only, by contract).

import fs from "node:fs";
import path from "node:path";
import { ensureHome, kitchenHome } from "../home.ts";

/** Parent variables any child may inherit as they are. */
const BASE = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TZ",
  // corporate proxies and CAs
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
] as const;

/** The agent tool's own auth and endpoint; an agent cannot run without them. Never given to app code. */
const AGENT_AUTH = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
] as const;

/** What the engine adds for the Toolkit control plane only (Docker). bin/dev must not pass these to the app. */
export const CONTROL_PLANE = ["DOCKER_HOST", "DOCKER_CONTEXT"] as const;

export type ScrubHome = { gitConfig: string; ghConfigDir: string };

function pick(parent: NodeJS.ProcessEnv, keys: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = parent[k];
    if (v !== undefined && v !== "") env[k] = v;
  }
  for (const [k, v] of Object.entries(parent)) if (k.startsWith("LC_") && v) env[k] = v;
  return env;
}

/** git and gh with no way to authenticate or push. */
function scrub(home: ScrubHome): Record<string, string> {
  return {
    // git: no system config (macOS turns on osxkeychain there), a global config
    // with an empty credential helper, and command-scope overrides that also
    // beat anything set in the repo's own .git/config:
    //  0: no credential helper
    //  1: every push URL is rewritten to an unknown transport, so `git push` fails
    //     for any remote, including a plain local path (fetch still works)
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: home.gitConfig,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "url.kitchen-push-blocked:///.pushInsteadOf",
    GIT_CONFIG_VALUE_1: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_SSH_COMMAND: "false",
    // gh: an empty config dir means no logged-in host
    GH_CONFIG_DIR: home.ghConfigDir,
    GH_PROMPT_DISABLED: "1",
  };
}

/** Pure: the env an agent gets, given the parent env and the scrub home files. */
export function scrubEnv(parent: NodeJS.ProcessEnv, home: ScrubHome): Record<string, string> {
  return { ...pick(parent, [...BASE, ...AGENT_AUTH]), ...scrub(home), KITCHEN_AGENT: "1" };
}

/** Writes the files the scrub points at into `dir` (engine-owned, outside every writable root). */
export function prepareScrubHome(dir: string): ScrubHome {
  const ghConfigDir = path.join(dir, "gh");
  fs.mkdirSync(ghConfigDir, { recursive: true });
  const gitConfig = path.join(dir, "gitconfig");
  fs.writeFileSync(gitConfig, "[credential]\n\thelper =\n");
  return { gitConfig, ghConfigDir };
}

export function buildAgentEnv(dir: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return scrubEnv(parent, prepareScrubHome(dir));
}

/** `KEY=value` lines; `#` comments and blanks skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/**
 * Pure: the env for a process that runs worktree code. Allowlist + git/gh scrub
 * + the app's `.env.kitchen` values. The scrub wins over `.env.kitchen`, so an
 * app file can't turn a credential helper back on.
 */
export function untrustedEnvOf(parent: NodeJS.ProcessEnv, home: ScrubHome, app: Record<string, string>): Record<string, string> {
  return { ...pick(parent, BASE), ...app, ...scrub(home), KITCHEN_UNTRUSTED: "1" };
}

/**
 * The env for every process that runs code from a worktree (`src`). Note: this
 * hands such code no credentials, but it does not confine it. The process still
 * runs as the user, unsandboxed: it can read files under $HOME (including
 * $KITCHEN_HOME) or unset these variables. An OS sandbox for app processes is
 * a later hardening item (ADR 0006).
 */
export function untrustedEnv(src: string, parent: NodeJS.ProcessEnv = process.env, home = kitchenHome()): Record<string, string> {
  const scrubHome = prepareScrubHome(path.join(ensureHome(home), "scrub"));
  const envFile = path.join(src, ".env.kitchen");
  const app = fs.existsSync(envFile) ? parseEnvFile(fs.readFileSync(envFile, "utf8")) : {};
  return untrustedEnvOf(parent, scrubHome, app);
}

/**
 * The env for the engine's own git calls (src/engine/git.ts): the untrusted
 * allowlist and scrub (no system config, the engine-written global config, no
 * credentials), but NOT the worktree's `.env.kitchen`, which could otherwise
 * choose PATH or GIT_* for git itself. The scrub files are rewritten on every
 * call, so an edit to them doesn't stick.
 */
export function engineGitEnv(parent: NodeJS.ProcessEnv = process.env, home = kitchenHome()): Record<string, string> {
  return untrustedEnvOf(parent, prepareScrubHome(path.join(ensureHome(home), "scrub")), {});
}

/**
 * The env for the Toolkit's bin/dev: untrusted, plus the Docker variables the
 * control plane needs, named in KITCHEN_CONTROL_ENV so bin/dev strips exactly
 * those before it starts the app.
 */
export function toolkitEnv(src: string, parent: NodeJS.ProcessEnv = process.env, home = kitchenHome()): Record<string, string> {
  const env = untrustedEnv(src, parent, home);
  for (const k of CONTROL_PLANE) if (parent[k]) env[k] = parent[k] as string;
  if (parent.KITCHEN_TOOLKIT_STATE) env.KITCHEN_TOOLKIT_STATE = parent.KITCHEN_TOOLKIT_STATE;
  env.KITCHEN_CONTROL_ENV = [...CONTROL_PLANE, "KITCHEN_TOOLKIT_STATE", "KITCHEN_CONTROL_ENV"].join(",");
  return env;
}
