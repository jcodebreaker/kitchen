// Stamped evidence entries (PLAN §2 "Proofs"). Only the engine appends.
//
// Integrity, and what it does and does not protect:
// - Each entry carries the sha256 of every evidence file it cites, so a
//   replaced screenshot or call record is refused.
// - Each entry carries `prev`, the sha256 of the previous entry's line, so the
//   file is a hash chain: an edited, dropped or reordered line breaks it.
// - The engine keeps the head `{n, hash}` of the chain in job.json (never next
//   to the manifest) with an HMAC over it, keyed by the engine key in
//   $KITCHEN_HOME (mode 600). `verifyManifest` requires that head: a manifest
//   that is shorter, longer, swapped for another job's, or deleted while the
//   engine expects entries is refused, and ids never restart (they come from
//   the head, not from the file).
//
// This protects the engine's records from out-of-band edits by anything that
// cannot read the engine key. Agents cannot write job state at all (it is
// outside their writable root, ADR 0006); the key keeps a writer that slips
// past that (or a hand edit of job.json) from forging a matching head. It does
// NOT protect against a process that can read the key and write job state:
// today that is any unsandboxed process running as the user, including app code
// started from a worktree. See ADR 0006, "Manifest integrity", for the residual risk.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type FileRef = { path: string; sha256: string };
export type Stamp = {
  id: string; // e1, e2, … cited by Verdicts and the Report
  prev: string; // sha256 of the previous entry's line (GENESIS for e1)
  sha: string; // commit of the source the proof ran against
  round: number;
  criterion: string;
  cmd: string; // what ran, as one readable line
  exit: number;
  files: FileRef[]; // evidence files (relative to the evidence dir) with their hashes
  at: string; // ISO time
};
export type Entry = Stamp & Record<string, unknown>;
export type ManifestHead = { n: number; hash: string; mac: string };
export type Seal = { scope: string; key: Buffer };

export class ManifestTampered extends Error {}

export const MANIFEST = "manifest.jsonl";
export const GENESIS = "0".repeat(64);

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const macOf = (seal: Seal, n: number, hash: string) => createHmac("sha256", seal.key).update(`kitchen-manifest-v1\n${seal.scope}\n${n}\n${hash}`).digest("hex");

/** The head of a manifest with no entries. The engine stores it when the job is created. */
export const emptyHead = (seal: Seal): ManifestHead => ({ n: 0, hash: GENESIS, mac: macOf(seal, 0, GENESIS) });

export const nextId = (head: ManifestHead) => `e${head.n + 1}`;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function insideDir(dir: string, rel: string): string {
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new ManifestTampered(`file ${rel} is outside the evidence dir`);
  return abs;
}

function checkMac(head: ManifestHead, seal: Seal) {
  const want = Buffer.from(macOf(seal, head.n, head.hash), "hex");
  const got = Buffer.from(String(head.mac ?? ""), "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ManifestTampered("manifest head signature does not match the engine key: refused");
}

/**
 * Verify the manifest in `dir` against the head the engine recorded. Returns the
 * entries when intact; throws ManifestTampered otherwise. The head is required.
 */
export function verifyManifest(dir: string, expected: ManifestHead, seal: Seal): Entry[] {
  if (!expected || typeof expected.n !== "number") throw new ManifestTampered("no expected manifest head given: refused");
  checkMac(expected, seal);
  const text = readText(path.join(dir, MANIFEST));
  if (text === null || text === "") {
    if (expected.n === 0) return [];
    throw new ManifestTampered(`${MANIFEST} is missing or empty but the engine recorded ${expected.n} entries: refused`);
  }
  if (!text.endsWith("\n")) throw new ManifestTampered(`${MANIFEST} does not end with a newline: refused`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== expected.n) throw new ManifestTampered(`${MANIFEST} has ${lines.length} entries, engine recorded ${expected.n}: refused`);
  let prev = GENESIS;
  const entries = lines.map((line, i) => {
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      throw new ManifestTampered(`line ${i + 1} is not JSON: refused`);
    }
    if (e.id !== `e${i + 1}`) throw new ManifestTampered(`line ${i + 1} has id ${e.id}, expected e${i + 1}: refused`);
    if (e.prev !== prev) throw new ManifestTampered(`${e.id} does not chain to the entry before it: refused`);
    for (const f of e.files ?? []) {
      const buf = (() => {
        try {
          return fs.readFileSync(insideDir(dir, f.path));
        } catch (err) {
          if (err instanceof ManifestTampered) throw err;
          throw new ManifestTampered(`${e.id} cites ${f.path}, which is missing: refused`);
        }
      })();
      if (sha256(buf) !== f.sha256) throw new ManifestTampered(`${e.id} cites ${f.path}, whose content changed: refused`);
    }
    prev = sha256(line);
    return e;
  });
  if (prev !== expected.hash) throw new ManifestTampered(`${MANIFEST} head ${prev.slice(0, 12)} ≠ recorded ${expected.hash.slice(0, 12)}: refused`);
  return entries;
}

export type NewEntry = Omit<Stamp, "id" | "prev" | "at" | "files"> & { files?: string[] } & Record<string, unknown>;

/**
 * Append one stamped entry. Verifies against `head` first, so a tampered
 * manifest is never extended; hashes the cited files; returns the entry and the
 * new head, which the caller must store (job.json) before anything else runs.
 * Callers hold the job's drive lock, so `nextId(head)` is the id this gets.
 */
export function appendEntry(dir: string, head: ManifestHead, entry: NewEntry, seal: Seal, now = new Date()): { entry: Entry; head: ManifestHead } {
  fs.mkdirSync(dir, { recursive: true });
  verifyManifest(dir, head, seal);
  const { id: _id, prev: _prev, at: _at, files = [], ...rest } = entry as Record<string, unknown> & { files?: string[] };
  const refs: FileRef[] = files.map((rel) => ({ path: rel, sha256: sha256(fs.readFileSync(insideDir(dir, rel))) }));
  const full = { id: nextId(head), prev: head.hash, ...rest, files: refs, at: now.toISOString() } as Entry;
  const line = JSON.stringify(full);
  fs.appendFileSync(path.join(dir, MANIFEST), `${line}\n`);
  const hash = sha256(line);
  return { entry: full, head: { n: head.n + 1, hash, mac: macOf(seal, head.n + 1, hash) } };
}
