// Stamped evidence entries. Only the engine appends; after every append it
// records sha256(manifest.jsonl). Anything that edits the file behind the
// engine's back (an agent with a shell, a hand edit) breaks the hash and the
// manifest is refused. In the real engine the hash lives in job.json
// (`manifestHash`); in this spike it sits beside the manifest in
// manifest.sha256, which the verifier must not be able to write either.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Stamp = {
  id: string; // e1, e2, … cited by Verdicts and the Report
  sha: string; // app commit the proof ran against
  round: number;
  criterion: string;
  cmd: string; // what ran, as one readable line
  exit: number;
  at: string; // ISO time
};
export type Entry = Stamp & Record<string, unknown>;

export class ManifestTampered extends Error {}

export const MANIFEST = "manifest.jsonl";
export const HASH_FILE = "manifest.sha256";

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/** The hash the engine last recorded, or null for a manifest never written. */
export function recordedHash(dir: string): string | null {
  const h = readText(path.join(dir, HASH_FILE)).trim();
  return h || null;
}

/**
 * Refuse a manifest whose bytes don't match the recorded hash. Returns the
 * parsed entries when it is intact. `expected` overrides the hash file (the
 * engine passes job.json's manifestHash).
 */
export function verifyManifest(dir: string, expected: string | null = recordedHash(dir)): Entry[] {
  const text = readText(path.join(dir, MANIFEST));
  if (expected === null) {
    if (text) throw new ManifestTampered(`${MANIFEST} exists but no hash was ever recorded`);
    return [];
  }
  const actual = sha256(text);
  if (actual !== expected) {
    throw new ManifestTampered(`${MANIFEST} hash ${actual.slice(0, 12)} ≠ recorded ${expected.slice(0, 12)}: refused`);
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry);
}

/**
 * Append one stamped entry. Verifies first, so a tampered manifest is never
 * extended, then assigns the next id and records the new hash. Returns the entry.
 */
export function appendEntry(dir: string, entry: Omit<Stamp, "id" | "at"> & Record<string, unknown>, now = new Date()): Entry {
  fs.mkdirSync(dir, { recursive: true });
  const existing = verifyManifest(dir);
  const { id: _id, at: _at, ...rest } = entry as Record<string, unknown>;
  const full = { id: `e${existing.length + 1}`, ...rest, at: now.toISOString() } as Entry;
  const file = path.join(dir, MANIFEST);
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
  const hashTmp = path.join(dir, `${HASH_FILE}.tmp`);
  fs.writeFileSync(hashTmp, sha256(fs.readFileSync(file)));
  fs.renameSync(hashTmp, path.join(dir, HASH_FILE));
  return full;
}
