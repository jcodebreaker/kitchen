// The repos one dashboard shows (ADR 0019): ~/.kitchen/repos.json ($KITCHEN_HOME moves it, for tests).
// `kitchen init` and `kitchen dashboard` add the repo they run in; `kitchen dashboard --forget` removes it.
// It holds paths only. A repo whose folder or .kitchen/ is gone is left out when the list is read.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kitchenDir } from "../engine/store.ts";

export type RepoEntry = { key: string; path: string };
export type RepoList = { repos: RepoEntry[]; last: string | null };

export const kitchenHome = () => process.env.KITCHEN_HOME || path.join(os.homedir(), ".kitchen");
export const reposFile = () => path.join(kitchenHome(), "repos.json");

/** The list as it is on disk, without the repos that are gone. A missing or unreadable file is an empty list. */
export function readRepos(file = reposFile()): RepoList {
  let raw: Partial<RepoList>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RepoList>;
  } catch {
    return { repos: [], last: null };
  }
  const repos = (Array.isArray(raw.repos) ? raw.repos : []).filter(
    (r): r is RepoEntry => typeof r?.key === "string" && typeof r?.path === "string" && fs.existsSync(kitchenDir(r.path)),
  );
  const last = typeof raw.last === "string" && repos.some((r) => r.key === raw.last) ? raw.last : null;
  return { repos, last };
}

function write(file: string, l: RepoList): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(l, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Adds the repo (or finds it) and makes it the one a hash-less page opens. Its key: the folder name, made URL-safe,
 *  with a short hash of its path when another repo on the list already has that name. */
export function addRepo(repo: string, file = reposFile()): RepoEntry {
  const p = fs.realpathSync(repo);
  const l = readRepos(file);
  let e = l.repos.find((r) => r.path === p);
  if (!e) {
    const base = path.basename(p).replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";
    const key = l.repos.some((r) => r.key === base) ? `${base}-${createHash("sha256").update(p).digest("hex").slice(0, 6)}` : base;
    e = { key, path: p };
    l.repos.push(e);
  }
  write(file, { repos: l.repos, last: e.key });
  return e;
}

/** Removes the repo; false when it wasn't on the list. */
export function forgetRepo(repo: string, file = reposFile()): boolean {
  const p = fs.existsSync(repo) ? fs.realpathSync(repo) : path.resolve(repo);
  const l = readRepos(file);
  const repos = l.repos.filter((r) => r.path !== p);
  if (repos.length === l.repos.length) return false;
  write(file, { repos, last: repos.some((r) => r.key === l.last) ? l.last : (repos.at(-1)?.key ?? null) });
  return true;
}

/** A path as the switcher shows it: under the home folder, with ~. */
export const shownPath = (p: string) => (p === os.homedir() || p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);
