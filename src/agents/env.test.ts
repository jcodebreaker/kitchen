import { describe, expect, it } from 'vitest';
import { scrubEnv } from './env.js';

const home = { gitConfig: '/k/agent/gitconfig', ghConfigDir: '/k/agent/gh' };

describe('scrubEnv', () => {
  const parent = {
    HOME: '/Users/x', PATH: '/usr/bin', LC_ALL: 'C',
    GH_TOKEN: 't', GITHUB_TOKEN: 't', SSH_AUTH_SOCK: '/tmp/s', AWS_SECRET_ACCESS_KEY: 's',
    GIT_SSH_COMMAND: 'ssh -i key', GIT_CONFIG_GLOBAL: '/Users/x/.gitconfig', ANTHROPIC_API_KEY: 'a',
  };
  const env = scrubEnv(parent, home);

  it('keeps only allowlisted variables', () => {
    expect(env.HOME).toBe('/Users/x');
    expect(env.LC_ALL).toBe('C');
    expect(env.ANTHROPIC_API_KEY).toBe('a');
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY']) expect(env[k]).toBeUndefined();
  });

  it('closes every push path', () => {
    expect(env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: home.gitConfig,
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'false',
      GH_CONFIG_DIR: home.ghConfigDir,
    });
  });
});
