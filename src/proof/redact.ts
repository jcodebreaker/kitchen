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

/**
 * `NAME_KEY=value`, `"password": "value"`, `X-Auth-Token: value`: the value is masked, the name kept, but
 * only when the name is secret-named (see `secretName`). `author=tolkien` is not. The value stops at
 * whitespace, a quote, a separator, markup (`<`, `>`) or an HTML entity, so a mask never swallows a tag.
 */
const QUOTE = `(?:["'\`]|&quot;|&#0?39;|&#x27;|&apos;)`;
const NAMED = new RegExp(
  `([A-Za-z][A-Za-z0-9_.-]*)(${QUOTE}?\\s*[:=]\\s*${QUOTE}?)(?!Bearer\\b|Basic\\b|\\[redacted\\])((?:(?!&(?:[a-z]+|#[0-9]+|#x[0-9a-f]+);)[^\\s"'\`,;{}<>])+)`,
  "gi",
);
/** Substrings that make any name secret-named (`DB_PASSWORD`, `apiToken`, `client_secret`). */
const SECRET_WORDS = ["secret", "token", "passw", "credential", "apikey", "privatekey", "accesskey"];
/** Whole name parts that do (`key`, `X-Auth-Token`, `session_id`), but not inside a word (`author`, `monkey`). */
const SECRET_PARTS = new Set(["key", "auth", "authorization", "cookie", "cookies", "session", "sessionid", "pwd", "creds"]);

/** True when a key name is named like a secret: by its words, split on `_ - .` and camelCase. */
export function secretName(name: string): boolean {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean);
  const joined = parts.join("");
  return SECRET_WORDS.some((w) => joined.includes(w)) || parts.some((p) => SECRET_PARTS.has(p));
}
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g;
const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi;

export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, MASK);
  out = out.replace(BEARER, (_m, kind: string) => `${kind} ${MASK}`);
  out = out.replace(URL_CREDS, (_m, a: string, _pw: string, at: string) => `${a}${MASK}${at}`);
  out = out.replace(NAMED, (m, name: string, sep: string, value: string) => (value.length >= 6 && secretName(name) ? `${name}${sep}${MASK}` : m));
  return out;
}
