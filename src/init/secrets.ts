// Secret scan before `kitchen init` commits the setup branch (`.env.kitchen`, the
// Toolkit, any dev-environment files). The contract says `.env.kitchen` holds
// fake or sandbox values only; this is the engine holding the setup agent to it.
// A commit is refused, naming the file and key, when a staged file holds:
//   - a known live-credential shape: sk_live_ (Stripe), AKIA… (AWS), ghp_/gho_
//     (GitHub), xox[baprs]- (Slack), a PEM private key block;
//   - a value from the developer's own untracked .env* files (their real config),
//     when that value looks like a secret (not a port, a boolean, a bare URL).
// Pure apart from `devEnvValues`, which reads the repo's untracked .env* files.
import fs from "node:fs";
import path from "node:path";
import { parseEnvFile } from "../agents/env.ts";

export type Finding = { file: string; line: number; key?: string; why: string };

const PATTERNS: { re: RegExp; why: string }[] = [
  { re: /sk_live_[A-Za-z0-9]{8,}/, why: "a live Stripe secret key (sk_live_…)" },
  { re: /rk_live_[A-Za-z0-9]{8,}/, why: "a live Stripe restricted key (rk_live_…)" },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, why: "an AWS access key id (AKIA…)" },
  { re: /\bgh[po]_[A-Za-z0-9]{20,}/, why: "a GitHub token (ghp_/gho_…)" },
  { re: /\bgh[usr]_[A-Za-z0-9]{20,}/, why: "a GitHub token (ghu_/ghs_/ghr_…)" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, why: "a Slack token (xox?-…)" },
  { re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/, why: "a private key block" },
];

/** Pure: a value worth matching against the developer's env: long enough, and not a port, flag or credential-free URL. */
export function secretLike(v: string): boolean {
  const s = v.trim().replace(/^["']|["']$/g, "");
  if (s.length < 8 || /\s/.test(s)) return false;
  if (/^\d+$/.test(s) || /^(true|false|yes|no|on|off|null|none|development|production|test|localhost)$/i.test(s)) return false;
  try {
    const u = new URL(s);
    if (u.protocol && u.host) return !!u.password; // a URL is a secret only with a password in it
  } catch {}
  return true;
}

/** Pure: findings in one file's text. `devValues` maps a secret-looking value of the developer's env to the key it had there. */
export function scanText(file: string, text: string, devValues: Map<string, string> = new Map()): Finding[] {
  const out: Finding[] = [];
  const isEnv = /(^|\/)\.env[^/]*$/.test(file);
  text.split("\n").forEach((raw, i) => {
    const m = isEnv ? /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw) : null;
    const key = m?.[1];
    for (const p of PATTERNS) if (p.re.test(raw)) out.push({ file, line: i + 1, ...(key ? { key } : {}), why: p.why });
    if (devValues.size) {
      const value = m ? m[2].replace(/^["']|["']$/g, "") : null;
      for (const [v, devKey] of devValues) {
        if (value !== null ? value === v : raw.includes(v)) {
          out.push({ file, line: i + 1, ...(key ? { key } : {}), why: `the same value as ${devKey} in your own env file (a real value, not a fake one)` });
          break;
        }
      }
    }
  });
  return out;
}

/** Secret-looking values of the developer's untracked .env* files at the repo root (never .env.kitchen, never tracked examples). */
export function devEnvValues(repo: string, tracked: Set<string>): Map<string, string> {
  const vals = new Map<string, string>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(repo).filter((n) => /^\.env(\..+)?$/.test(n) && n !== ".env.kitchen" && !tracked.has(n));
  } catch {}
  for (const n of names) {
    let env: Record<string, string> = {};
    try {
      if (!fs.statSync(path.join(repo, n)).isFile()) continue;
      env = parseEnvFile(fs.readFileSync(path.join(repo, n), "utf8"));
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(env)) {
      const s = v.replace(/^["']|["']$/g, "");
      if (secretLike(s)) vals.set(s, `${k} (${n})`);
    }
  }
  return vals;
}

/** Pure: the refusal message for a set of findings. */
export function refusal(findings: Finding[], where: string): string {
  const lines = findings.slice(0, 10).map((f) => `  ${f.file}:${f.line}${f.key ? ` ${f.key}` : ""}: ${f.why}`);
  return [
    `secret scan: refusing to commit the setup branch: ${findings.length} value(s) look like real credentials`,
    ...lines,
    ...(findings.length > 10 ? [`  … and ${findings.length - 10} more`] : []),
    `Replace them with fake or sandbox values in ${where} and run kitchen init again (.env.kitchen holds fake values only).`,
  ].join("\n");
}
