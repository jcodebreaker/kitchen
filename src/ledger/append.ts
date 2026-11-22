// The ledger (PLAN §2 "Ledger line"): .kitchen/ledger.jsonl, append-only.
// Every line carries a `key`. A stage that runs again after a crash appends the
// same key again; readers keep the first line per key, so nothing counts twice.
import fs from "node:fs";
import path from "node:path";

export type LedgerLine = {
  t: string;
  job: string;
  stage: string;
  round: number;
  event: string;
  key: string;
  result?: string;
  role?: string;
  agent?: string;
  model?: string;
  secs?: number;
  usd?: number;
  detail?: Record<string, unknown>;
};

export const ledgerFile = (repo: string) => path.join(repo, ".kitchen", "ledger.jsonl");

/**
 * One line, one write: an O_APPEND write of one short line is not interleaved with another.
 * A last line torn by a crash (no newline) is closed first, so it can't swallow this one.
 */
export function appendLedger(repo: string, line: Omit<LedgerLine, "t"> & { t?: string }) {
  const f = ledgerFile(repo);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const text = `${JSON.stringify({ t: line.t ?? new Date().toISOString(), ...line })}\n`;
  fs.appendFileSync(f, endsTorn(f) ? `\n${text}` : text);
}

function endsTorn(f: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(f, "r");
  } catch {
    return false;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return false;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

/** Pure: parse ledger text, keep the first line per key, skip a torn line. */
export function dedupe(text: string): LedgerLine[] {
  const seen = new Set<string>();
  const out: LedgerLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let l: LedgerLine;
    try {
      l = JSON.parse(raw) as LedgerLine;
    } catch {
      continue; // a line torn by a crash mid-write
    }
    if (!l.key || seen.has(l.key)) continue;
    seen.add(l.key);
    out.push(l);
  }
  return out;
}

export function readLedger(repo: string): LedgerLine[] {
  const f = ledgerFile(repo);
  return fs.existsSync(f) ? dedupe(fs.readFileSync(f, "utf8")) : [];
}

/** Raw line count per key (> 1 means a step re-ran and readers de-duplicate it). */
export function rawKeyCounts(repo: string): Map<string, number> {
  const f = ledgerFile(repo);
  const m = new Map<string, number>();
  if (!fs.existsSync(f)) return m;
  for (const raw of fs.readFileSync(f, "utf8").split("\n")) {
    try {
      const k = (JSON.parse(raw) as LedgerLine).key;
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    } catch {}
  }
  return m;
}
