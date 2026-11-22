// Masks secret-looking strings in text evidence (PLAN §2 "Redaction") before it
// leaves the engine: what the bridge hands an agent (a proof's output, a check's
// tail) goes through here, and so does every text evidence file when it is
// written (stamp-cmd, drive), before the manifest hashes it. Screenshots can't
// be scanned, so Toolkits seed only fake data. `redact` is pure.
import fs from "node:fs";
import path from "node:path";

const MASK = "[redacted]";

/**
 * Redacts every text file under `dir` in place (a file with a NUL byte is binary: a
 * screenshot is left as it is). Called before the files are hashed into the manifest,
 * so no evidence file on disk ever holds the secret.
 */
export function redactTextFiles(dir: string): void {
  for (const d of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!d.isFile()) continue;
    const f = path.join(d.parentPath, d.name);
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue;
    const text = buf.toString("utf8");
    const out = redact(text);
    if (out !== text) fs.writeFileSync(f, out);
  }
}

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bsk-(ant-|proj-|live_|test_)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / Stripe secret keys
  /\b(rk|pk)_(live|test)_[A-Za-z0-9]{16,}/g, // Stripe restricted/publishable keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
];

/** `NAME_KEY=value`, `"password": "value"`, `Authorization: Bearer value`: the value is masked, the name kept. */
const NAMED =
  /((?:[A-Za-z0-9_]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|\[redacted\])([^\s"',;}{]{6,})/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g;
const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi;

export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, MASK);
  out = out.replace(BEARER, (_m, kind: string) => `${kind} ${MASK}`);
  out = out.replace(URL_CREDS, (_m, a: string, _pw: string, at: string) => `${a}${MASK}${at}`);
  out = out.replace(NAMED, (_m, name: string) => `${name}${MASK}`);
  return out;
}
