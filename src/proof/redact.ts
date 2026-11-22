// Masks secret-looking strings in text evidence (PLAN §2 "Redaction") before it
// leaves the engine: what the bridge hands an agent (a proof's output, a check's
// tail) goes through here. Screenshots can't be scanned, so Toolkits seed only
// fake data. Pure.

const MASK = "[redacted]";

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
