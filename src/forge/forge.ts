// Where PRs, CI checks, Toolkit PRs and Toolkit tickets live (PLAN §1 forge/).
// Every write is idempotent by lookup: the engine records a key in `filed`
// after it, but a crash in between runs it again, so each method looks first.
// `local` (no remote; Toolkit PRs are local branches a human merges), `fake`
// (a JSON file the spikes edit) and `github` (src/forge/github.ts: `gh` with the
// engine's credentials, pushes through engine/git.ts; W3b).
// W4 adds: publishEvidence (the `kitchen-evidence` branch, evidence-branch.ts),
// label (`kitchen:review-required`), reviewComments (done → build from a trusted
// person's PR comment) and openPr (`kitchen toolkit maintain`'s one Toolkit PR).
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { openGit, plainCheckout } from "../engine/git.ts";
import { writeAtomic } from "../engine/store.ts";
import { withFileLock } from "../lock.ts";
import { commitEvidence, EVIDENCE_BRANCH } from "./evidence-branch.ts";
import { GithubForge } from "./github.ts";

export type CiState = "none" | "pending" | "pass" | "fail";
/** A review comment on a PR. `association`: the author's relation to the repo (GitHub's author_association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE…). */
export type PrComment = { id: string; pr: number; author: string; association: string; body: string; at: string };
/** Where a job's published folder is: the branch commit, and a link prefix for files in it (`<url>report.html`). */
export type Published = { commit: string; url: string; pruned: string[] };
/** The smith's Toolkit PR: its branch (in the main repo) at `head`. */
export type ToolkitPrRequest = { key: string; title: string; body: string; branch: string; head: string };

export interface Forge {
  readonly kind: "local" | "fake" | "github";
  /** Push the job branch and open (or find) its draft PR. Local: nothing to push, no PR. */
  publish(o: { branch: string; title: string; head: string }): Promise<{ pushed: boolean; pr: number | null }>;
  checks(pr: number | null): Promise<CiState>;
  prMerged(pr: number): Promise<boolean>;
  /** Push the smith's Toolkit branch and open (or find) its PR, by key. */
  openToolkitPr(o: ToolkitPrRequest): Promise<number>;
  /** The draft PR becomes ready for review (report → done). */
  markReady(pr: number | null): Promise<void>;
  /** A Toolkit ticket, found by key. Returns its ref. */
  fileTicket(o: { key: string; title: string; body: string }): Promise<string>;
  ticketClosed(ref: string): Promise<boolean>;
  /** A PR comment, found by key (posted once; a second call with the key edits nothing). */
  comment(o: { key: string; pr: number | null; body: string }): Promise<void>;
  /** A label on the PR, found by key. */
  label(o: { key: string; pr: number | null; label: string }): Promise<void>;
  /**
   * The job's published folder: `bundle` (report.html, evidence/, published.json, already redacted) becomes
   * `<job>/` on the `kitchen-evidence` branch, folders older than `keepDays` pruned (evidence-branch.ts)
   * except the folders in `keep` (jobs that aren't done).
   */
  publishEvidence(o: { key: string; job: string; bundle: string; keepDays: number; keep?: readonly string[] }): Promise<Published>;
  /**
   * Comments on a PR, oldest first, each with its creation time (`at`, ISO) and the author's association.
   * A forge may leave Kitchen's own in: the runner drops every comment carrying KITCHEN_MARKER.
   */
  reviewComments(pr: number | null): Promise<PrComment[]>;
  /** A PR for a branch the engine made (maintain's Toolkit PR), found by key. */
  openPr(o: { key: string; branch: string; head: string; title: string; body: string }): Promise<number>;
}

/** Records of the local forge (no remote): one JSON line per side effect, so a run can be inspected. */
const localLog = (repo: string) => path.join(repo, ".kitchen", "local-forge.jsonl");
function localRecord(repo: string, o: Record<string, unknown> & { key: string }): boolean {
  const f = localLog(repo);
  const lines = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
  if (lines.some((l) => (JSON.parse(l) as { key: string }).key === o.key)) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${JSON.stringify({ ...o, at: new Date().toISOString() })}\n`);
  return true;
}
export function readLocalForge(repo: string): (Record<string, unknown> & { key: string; kind: string })[] {
  const f = localLog(repo);
  return fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}

/** No remote: nothing is pushed, no PR, no CI; Toolkit tickets are lines in .kitchen/tickets.jsonl that a human closes with `kitchen resume`. */
export class LocalForge implements Forge {
  readonly kind = "local" as const;
  private readonly repo: string;
  constructor(repo: string) {
    this.repo = repo;
  }
  async publish() {
    return { pushed: false, pr: null };
  }
  async checks(): Promise<CiState> {
    return "none";
  }
  /** A local Toolkit PR is merged when its head is in the base (the main checkout's HEAD). */
  async prMerged(pr: number) {
    const p = readLocalForge(this.repo).find((x) => x.kind === "toolkit-pr" && Number(x.n) === pr);
    if (!p) return false;
    const git = await openGit(plainCheckout(this.repo));
    try {
      await git.run(["merge-base", "--is-ancestor", String(p.head), "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }
  /** No remote: the smith's branch is the PR (a human merges it into the base); recorded with a local number. */
  async openToolkitPr(o: ToolkitPrRequest): Promise<number> {
    const prs = readLocalForge(this.repo).filter((x) => x.kind === "toolkit-pr");
    const had = prs.find((x) => x.key === o.key);
    if (had) return Number(had.n);
    const n = prs.length + 1;
    localRecord(this.repo, { kind: "toolkit-pr", n, ...o });
    return n;
  }
  async markReady() {}
  async fileTicket(o: { key: string; title: string; body: string }) {
    const f = path.join(this.repo, ".kitchen", "tickets.jsonl");
    const lines = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
    if (!lines.some((l) => (JSON.parse(l) as { key: string }).key === o.key))
      fs.appendFileSync(f, `${JSON.stringify({ ...o, at: new Date().toISOString() })}\n`);
    return `local:${o.key}`;
  }
  async ticketClosed() {
    return false;
  }
  /** No PR to comment on: the comment is recorded in .kitchen/local-forge.jsonl. */
  async comment(o: { key: string; pr: number | null; body: string }) {
    localRecord(this.repo, { kind: "comment", ...o });
  }
  async label(o: { key: string; pr: number | null; label: string }) {
    localRecord(this.repo, { kind: "label", ...o });
  }
  /** The branch stays in this repo (nothing is pushed); the url is `<branch>:<job>/`. */
  async publishEvidence(o: { key: string; job: string; bundle: string; keepDays: number; keep?: readonly string[] }): Promise<Published> {
    const r = await commitEvidence({ repo: this.repo, job: o.job, bundle: o.bundle, keepDays: o.keepDays, keep: o.keep });
    localRecord(this.repo, { kind: "evidence", key: `${o.key}/${r.commit}`, job: o.job, commit: r.commit });
    return { commit: r.commit, url: `${EVIDENCE_BRANCH}:${o.job}/`, pruned: r.pruned };
  }
  async reviewComments(): Promise<PrComment[]> {
    return [];
  }
  /** No remote: the branch is the PR; recorded with a local number. */
  async openPr(o: { key: string; branch: string; head: string; title: string; body: string }): Promise<number> {
    const prs = readLocalForge(this.repo).filter((x) => x.kind === "pr");
    const had = prs.find((x) => x.key === o.key);
    if (had) return Number(had.n);
    const n = prs.length + 1;
    localRecord(this.repo, { kind: "pr", n, ...o });
    return n;
  }
}

/** The fake forge's state file. Counts every call per key, so a side effect that ran twice shows. */
export type FakeForgeState = {
  prs: { n: number; branch: string; title: string; head: string; checks: CiState; merged: boolean; pushes: number; creates: number }[];
  toolkitPrs: { n: number; key: string; title: string; branch?: string; head?: string; merged: boolean; calls: number }[];
  /** PRs marked ready for review. */
  ready?: number[];
  tickets: { ref: string; key: string; title: string; closed: boolean; calls: number }[];
  comments: { key: string; pr: number | null; body: string; calls: number; at?: string }[];
  evidence: { key: string; job: string; commit: string; calls: number }[];
  labels: { key: string; pr: number | null; label: string; calls: number }[];
  /** Review comments people left on PRs (the spikes add them). */
  reviewComments: PrComment[];
  /** PRs the engine opened for its own branches (maintain). */
  branchPrs: { n: number; key: string; branch: string; head: string; title: string; body: string; calls: number }[];
  next: number;
  /** Checks state given to new PRs. */
  defaultChecks: CiState;
};

const emptyFake = (): FakeForgeState => ({
  prs: [],
  toolkitPrs: [],
  tickets: [],
  comments: [],
  evidence: [],
  labels: [],
  reviewComments: [],
  branchPrs: [],
  next: 1,
  defaultChecks: "pass",
});

export function readFakeForge(file: string): FakeForgeState {
  return fs.existsSync(file) ? { ...emptyFake(), ...(JSON.parse(fs.readFileSync(file, "utf8")) as FakeForgeState) } : emptyFake();
}

/** A JSON file instead of a remote. Its evidence branch is real: it is committed in `repo` (as a push would leave it). */
export class FakeForge implements Forge {
  readonly kind = "fake" as const;
  readonly file: string;
  private readonly repo: string | undefined;
  constructor(file: string, repo?: string) {
    this.file = file;
    this.repo = repo;
  }
  private async edit<T>(fn: (s: FakeForgeState) => T): Promise<T> {
    return withFileLock(`${this.file}.lock`, async () => {
      const s = readFakeForge(this.file);
      const r = fn(s);
      writeAtomic(this.file, JSON.stringify(s, null, 2));
      return r;
    });
  }
  publish(o: { branch: string; title: string; head: string }) {
    return this.edit((s) => {
      let pr = s.prs.find((p) => p.branch === o.branch);
      if (!pr) {
        pr = { n: s.next++, branch: o.branch, title: o.title, head: o.head, checks: s.defaultChecks, merged: false, pushes: 0, creates: 0 };
        s.prs.push(pr);
        pr.creates++;
      }
      if (pr.head !== o.head) pr.checks = s.defaultChecks; // a new push re-runs CI
      pr.head = o.head;
      pr.pushes++;
      return { pushed: true, pr: pr.n };
    });
  }
  async checks(pr: number | null): Promise<CiState> {
    if (pr === null) return "none";
    return readFakeForge(this.file).prs.find((p) => p.n === pr)?.checks ?? "none";
  }
  async prMerged(pr: number) {
    const s = readFakeForge(this.file);
    return !!(s.prs.find((p) => p.n === pr)?.merged || s.toolkitPrs.find((p) => p.n === pr)?.merged);
  }
  async markReady(pr: number | null) {
    if (pr === null) return;
    await this.edit((s) => {
      s.ready = s.ready ?? [];
      if (!s.ready.includes(pr)) s.ready.push(pr);
    });
  }
  openToolkitPr(o: ToolkitPrRequest) {
    return this.edit((s) => {
      let p = s.toolkitPrs.find((x) => x.key === o.key);
      if (!p) {
        p = { n: s.next++, key: o.key, title: o.title, branch: o.branch, head: o.head, merged: false, calls: 0 };
        s.toolkitPrs.push(p);
      }
      p.calls++;
      return p.n;
    });
  }
  fileTicket(o: { key: string; title: string; body: string }) {
    return this.edit((s) => {
      let t = s.tickets.find((x) => x.key === o.key);
      if (!t) {
        t = { ref: `T${s.next++}`, key: o.key, title: o.title, closed: false, calls: 0 };
        s.tickets.push(t);
      }
      t.calls++;
      return t.ref;
    });
  }
  async ticketClosed(ref: string) {
    return !!readFakeForge(this.file).tickets.find((t) => t.ref === ref)?.closed;
  }
  async comment(o: { key: string; pr: number | null; body: string }) {
    await this.edit((s) => {
      let c = s.comments.find((x) => x.key === o.key);
      if (!c) {
        c = { key: o.key, pr: o.pr, body: o.body, calls: 0, at: new Date().toISOString() };
        s.comments.push(c);
      }
      c.calls++;
    });
  }
  async label(o: { key: string; pr: number | null; label: string }) {
    await this.edit((s) => {
      let l = s.labels.find((x) => x.key === o.key);
      if (!l) {
        l = { key: o.key, pr: o.pr, label: o.label, calls: 0 };
        s.labels.push(l);
      }
      l.calls++;
    });
  }
  async publishEvidence(o: { key: string; job: string; bundle: string; keepDays: number; keep?: readonly string[] }): Promise<Published> {
    if (!this.repo) throw new Error("the fake forge has no repo to keep the evidence branch in");
    const r = await commitEvidence({ repo: this.repo, job: o.job, bundle: o.bundle, keepDays: o.keepDays, keep: o.keep });
    await this.edit((s) => {
      let e = s.evidence.find((x) => x.key === o.key);
      if (!e) {
        e = { key: o.key, job: o.job, commit: r.commit, calls: 0 };
        s.evidence.push(e);
      }
      e.commit = r.commit;
      e.calls++;
    });
    return { commit: r.commit, url: `fake://${EVIDENCE_BRANCH}/${o.job}/`, pruned: r.pruned };
  }
  /** People's comments and, as GitHub would list them, Kitchen's own (posted by the repo owner's token, so OWNER). */
  async reviewComments(pr: number | null): Promise<PrComment[]> {
    if (pr === null) return [];
    const s = readFakeForge(this.file);
    const own = s.comments
      .filter((c) => c.pr === pr)
      .map((c): PrComment => ({ id: `kitchen-${c.key}`, pr, author: "kitchen-bot", association: "OWNER", body: c.body, at: c.at ?? "" }));
    return [...s.reviewComments.filter((c) => c.pr === pr), ...own].sort((a, b) => a.at.localeCompare(b.at));
  }
  openPr(o: { key: string; branch: string; head: string; title: string; body: string }) {
    return this.edit((s) => {
      let p = s.branchPrs.find((x) => x.key === o.key);
      if (!p) {
        p = { n: s.next++, ...o, calls: 0 };
        s.branchPrs.push(p);
      }
      p.head = o.head;
      p.calls++;
      return p.n;
    });
  }
}

export function forgeFor(repo: string, cfg: Config): Forge {
  if (cfg.forge.kind === "fake") return new FakeForge(path.resolve(repo, cfg.forge.file ?? ".kitchen/fake-forge.json"), repo);
  if (cfg.forge.kind === "github") return new GithubForge(repo, cfg);
  return new LocalForge(repo);
}

/**
 * Whether a PR comment may send a done job back to build: its author is listed in kitchen.yaml
 * `feedback.trusted`, or their association with the repo is in `feedback.trust_associations`.
 * Pure. Anyone else's comment is ignored (and logged), so a drive-by comment can't steer the builder.
 */
export function isTrusted(c: Pick<PrComment, "author" | "association">, f: Config["feedback"]): boolean {
  if (f.trusted.some((t) => t.toLowerCase() === c.author.toLowerCase())) return true;
  return f.trust_associations.map((a) => a.toUpperCase()).includes(c.association.toUpperCase());
}
