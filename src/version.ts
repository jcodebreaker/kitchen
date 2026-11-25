// Kitchen's own build (ADR 0032 §1): the package version, and what the code on disk is (the compiled dist/, or src/
// when Kitchen runs from source, plus the dashboard page) so a long-running `kitchen dashboard` can tell it was
// rebuilt or updated under it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
/** The code this process runs: dist/ once built, src/ when run from source. */
const CODE = path.extname(import.meta.filename) === ".ts" ? "src" : "dist";

export const KITCHEN_VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;

/** Every file of the build: the code folder, the page, package.json; sorted. */
function files(root: string, code: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (!/\.(map|test\.ts)$/.test(n.name)) out.push(p);
    }
  };
  walk(path.join(root, code));
  return [...out, path.join(root, "dashboard", "dashboard.html"), path.join(root, "package.json")].sort();
}

/** Cheap: each file's size and mtime. A change here is only a hint (a rebuild rewrites every file as it was). */
function shape(fs_: string[]): string {
  return fs_
    .map((f) => {
      try {
        const s = fs.statSync(f);
        return `${f}\0${s.size}\0${s.mtimeMs}`;
      } catch {
        return `${f}\0-`;
      }
    })
    .join("\n");
}

/** What the build is: a hash of every file's contents. Read only when its shape changed. */
export function buildStamp(root = ROOT, code = CODE): string {
  const h = createHash("sha256");
  for (const f of files(root, code)) {
    h.update(`${path.relative(root, f)}\0`);
    try {
      h.update(fs.readFileSync(f));
    } catch {}
  }
  return h.digest("hex");
}

/**
 * Whether the build on disk differs from the one at start. Sizes and mtimes are looked at most every `ms`; once they
 * moved and then look the same twice in a row (a rebuild has finished writing), the contents are hashed, so a rebuild
 * that wrote the same files is no change and a half-written one is never judged. Nothing latches: a build put back
 * reads as not stale at the next settled look.
 */
export function staleWatch(o: { root?: string; code?: string; ms?: number; now?: () => number } = {}): () => boolean {
  const root = o.root ?? ROOT;
  const code = o.code ?? CODE;
  const ms = o.ms ?? 5000;
  const now = o.now ?? Date.now;
  const start = buildStamp(root, code);
  let last = shape(files(root, code));
  let moved = false;
  let at = now();
  let stale = false;
  return () => {
    if (now() - at < ms) return stale;
    at = now();
    const s = shape(files(root, code));
    if (s !== last) {
      // Still being written, perhaps: judge it at the next look that sees the same.
      last = s;
      moved = true;
    } else if (moved) {
      moved = false;
      stale = buildStamp(root, code) !== start;
    }
    return stale;
  };
}
