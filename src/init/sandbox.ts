// The OS sandbox for bin/dev runs the setup bridge starts (ADR 0008). The setup
// agent writes bin/dev, and `kitchen setup-mcp` runs it outside the agent's own
// sandbox (with network and Docker), so on macOS every such run goes through
// `sandbox-exec` with a profile that denies reading or writing the developer's
// credentials and Kitchen's own secrets, and allows everything else bin/dev
// needs (the repo, temp, the Docker socket and CLI config, the network).
// Linux: not handled yet (no profile; the bridge says so on start).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHome, kitchenHome } from "../home.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Under $HOME: the developer's credentials and the agent tools' auth. */
const DENIED_IN_HOME = [
  ".ssh",
  ".aws",
  ".config/gh",
  ".config/gcloud",
  ".azure",
  ".kube",
  ".gnupg",
  ".netrc",
  ".git-credentials",
  ".claude",
  ".claude.json",
  ".config/claude",
  ".codex",
  ".config/codex",
  ".anthropic",
  ".openai",
  "Library/Keychains",
  "Library/Application Support/Claude",
];

/** Pure: the denied paths, given home and KITCHEN_HOME (both as given and resolved: the profile matches real paths). */
export function deniedPaths(home: string, kHome: string, extra: string[] = []): string[] {
  const out = new Set<string>();
  for (const p of [...DENIED_IN_HOME.map((d) => path.join(home, d)), kHome, ...extra]) {
    out.add(p);
    try {
      out.add(fs.realpathSync(p));
    } catch {}
  }
  return [...out];
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Pure: the SBPL profile. Allow by default, then deny every read and write
 * under each denied path; `$KITCHEN_HOME/scrub` (the empty git and gh config
 * the untrusted env points at) is allowed back for reading. In SBPL the last
 * matching rule wins.
 */
export function profileText(denied: string[], allowRead: string[]): string {
  const sub = (p: string) => `(subpath ${q(p)})`;
  return [
    "(version 1)",
    ";; Kitchen setup bridge: bin/dev written by the setup agent (ADR 0008).",
    "(allow default)",
    `(deny file-read* file-write* ${denied.map(sub).join(" ")})`,
    ...(allowRead.length ? [`(allow file-read* ${allowRead.map(sub).join(" ")})`] : []),
    "",
  ].join("\n");
}

/**
 * A bin/dev that runs `bin` under the setup profile: a two-line wrapper in
 * $KITCHEN_HOME/sandbox/. Every caller (one command, the check, its drives, a
 * stale slot's reclaim) runs bin/dev by path, so wrapping the path confines
 * them all. Returns `bin` itself, with `sandboxed: false`, where there is no
 * sandbox-exec (Linux: unhandled, ADR 0008).
 */
export function sandboxedBin(bin: string, o: { home?: string; kHome?: string } = {}): { bin: string; sandboxed: boolean } {
  const profile = setupSandboxProfile(o);
  if (!profile) return { bin, sandboxed: false };
  let real = path.resolve(bin);
  try {
    real = fs.realpathSync(bin);
  } catch {}
  const wrapper = path.join(path.dirname(profile), `dev-${createHash("sha256").update(real).digest("hex").slice(0, 12)}`);
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\n# Kitchen setup bridge: ${real} under ${profile} (ADR 0008)\nexec ${SANDBOX_EXEC} -f ${sh(profile)} ${sh(real)} "$@"\n`,
    {
      mode: 0o700,
    },
  );
  fs.chmodSync(wrapper, 0o700);
  return { bin: wrapper, sandboxed: true };
}

const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * The profile file for this machine, written into $KITCHEN_HOME/sandbox/, or
 * null where there is no sandbox-exec (Linux: unhandled, see ADR 0008).
 */
export function setupSandboxProfile(o: { home?: string; kHome?: string } = {}): string | null {
  if (process.platform !== "darwin" || !fs.existsSync(SANDBOX_EXEC)) return null;
  const kHome = ensureHome(o.kHome ?? kitchenHome());
  const scrub = path.join(kHome, "scrub");
  fs.mkdirSync(scrub, { recursive: true, mode: 0o700 });
  const allow = [scrub];
  try {
    allow.push(fs.realpathSync(scrub));
  } catch {}
  const file = path.join(kHome, "sandbox", "setup-bridge.sb");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, profileText(deniedPaths(o.home ?? os.homedir(), kHome), allow), { mode: 0o600 });
  return file;
}
