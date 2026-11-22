// The scrubbed environment every agent is spawned with (PLAN §3).
// Built from an allowlist, never by deleting from the parent env: anything
// not named here (GH_TOKEN, cloud keys, SSH_AUTH_SOCK, ...) never reaches an agent.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Parent variables an agent may inherit as they are. */
const PASS_THROUGH = [
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ',
  // the agent tool's own auth and endpoint; it cannot run without them
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME',
  // corporate proxies and CAs
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
] as const;

export type AgentHome = { gitConfig: string; ghConfigDir: string };

/** Pure: the env an agent gets, given the parent env and the agent home files. */
export function scrubEnv(parent: NodeJS.ProcessEnv, home: AgentHome): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) {
    const v = parent[k];
    if (v !== undefined && v !== '') env[k] = v;
  }
  for (const [k, v] of Object.entries(parent)) {
    if (k.startsWith('LC_') && v) env[k] = v;
  }
  return {
    ...env,
    // git: no system config (macOS turns on osxkeychain there), a global config
    // with an empty credential helper, and a command-scope override that also
    // beats a helper set in the repo's own .git/config.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: home.gitConfig,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_SSH_COMMAND: 'false',
    // gh: an empty config dir means no logged-in host
    GH_CONFIG_DIR: home.ghConfigDir,
    GH_PROMPT_DISABLED: '1',
    KITCHEN_AGENT: '1',
  };
}

/** Writes the files scrubEnv points at into `dir` (engine-owned, outside every writable root). */
export function prepareAgentHome(dir: string): AgentHome {
  const ghConfigDir = join(dir, 'gh');
  mkdirSync(ghConfigDir, { recursive: true });
  const gitConfig = join(dir, 'gitconfig');
  writeFileSync(gitConfig, '[credential]\n\thelper =\n');
  return { gitConfig, ghConfigDir };
}

export function buildAgentEnv(dir: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return scrubEnv(parent, prepareAgentHome(dir));
}
