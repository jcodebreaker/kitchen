// Where PRs, CI checks, Toolkit PRs and Toolkit tickets live (PLAN §1 forge/).
// Every write is idempotent by lookup: the engine records a key in `filed`
// after it, but a crash in between runs it again, so each method looks first.
// W1 ships `local` (no remote) and `fake` (a JSON file the spikes edit).
// GitHub comes in W3b.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { writeAtomic } from "../engine/store.ts";
import { withFileLock } from "../lock.ts";

export type CiState = "none" | "pending" | "pass" | "fail";

export interface Forge {
  readonly kind: "local" | "fake" | "github";
  /** Push the job branch and open (or find) its draft PR. Local: nothing to push, no PR. */
  publish(o: { branch: string; title: string; head: string }): Promise<{ pushed: boolean; pr: number | null }>;
  checks(pr: number | null): Promise<CiState>;
  prMerged(pr: number): Promise<boolean>;
  /** A Toolkit PR from the smith, found by key. */
  openToolkitPr(o: { key: string; title: string }): Promise<number>;
  /** A Toolkit ticket, found by key. Returns its ref. */
  fileTicket(o: { key: string; title: string; body: string }): Promise<string>;
  ticketClosed(ref: string): Promise<boolean>;
  /** A PR comment, found by key. */
  comment(o: { key: string; pr: number | null; body: string }): Promise<void>;
  pushEvidence(o: { key: string; job: string; dir: string }): Promise<boolean>;
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
  async prMerged() {
    return false;
  }
  async openToolkitPr(): Promise<number> {
    throw new Error("the local forge has no Toolkit PRs (W3b)");
  }
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
  async comment() {}
  async pushEvidence() {
    return false;
  }
}

/** The fake forge's state file. Counts every call per key, so a side effect that ran twice shows. */
export type FakeForgeState = {
  prs: { n: number; branch: string; title: string; head: string; checks: CiState; merged: boolean; pushes: number; creates: number }[];
  toolkitPrs: { n: number; key: string; title: string; merged: boolean; calls: number }[];
  tickets: { ref: string; key: string; title: string; closed: boolean; calls: number }[];
  comments: { key: string; pr: number | null; calls: number }[];
  evidence: { key: string; job: string; calls: number }[];
  next: number;
  /** Checks state given to new PRs. */
  defaultChecks: CiState;
};

const emptyFake = (): FakeForgeState => ({ prs: [], toolkitPrs: [], tickets: [], comments: [], evidence: [], next: 1, defaultChecks: "pass" });

export function readFakeForge(file: string): FakeForgeState {
  return fs.existsSync(file) ? { ...emptyFake(), ...(JSON.parse(fs.readFileSync(file, "utf8")) as FakeForgeState) } : emptyFake();
}

export class FakeForge implements Forge {
  readonly kind = "fake" as const;
  readonly file: string;
  constructor(file: string) {
    this.file = file;
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
  openToolkitPr(o: { key: string; title: string }) {
    return this.edit((s) => {
      let p = s.toolkitPrs.find((x) => x.key === o.key);
      if (!p) {
        p = { n: s.next++, key: o.key, title: o.title, merged: false, calls: 0 };
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
        c = { key: o.key, pr: o.pr, calls: 0 };
        s.comments.push(c);
      }
      c.calls++;
    });
  }
  pushEvidence(o: { key: string; job: string }) {
    return this.edit((s) => {
      let e = s.evidence.find((x) => x.key === o.key);
      if (!e) {
        e = { key: o.key, job: o.job, calls: 0 };
        s.evidence.push(e);
      }
      e.calls++;
      return true;
    });
  }
}

export function forgeFor(repo: string, cfg: Config): Forge {
  if (cfg.forge.kind === "fake") return new FakeForge(path.resolve(repo, cfg.forge.file ?? ".kitchen/fake-forge.json"));
  if (cfg.forge.kind === "github") throw new Error("forge: github comes in W3b");
  return new LocalForge(repo);
}
