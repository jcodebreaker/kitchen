// The GitHub forge (PLAN §1 forge/github.ts): `gh` with the ENGINE's credentials
// (agents never get them: their env has no GH_TOKEN and an empty GH_CONFIG_DIR,
// ADR 0006). Pushes go through engine/git.ts to the explicit URL with
// --receive-pack; `gh` only talks to the API.
//
// Every write is idempotent by lookup, because a crash between the write and the
// engine recording its key runs it again:
//   PR             found by head branch (`gh pr list --head`)
//   comment        found by a hidden marker `<!-- kitchen:<key> -->` in its body
//   Toolkit ticket found by the same marker among issues labelled kitchen-toolkit
//   evidence       a new commit on kitchen-evidence replaces the job's folder
// `gh` is `$KITCHEN_GH_BIN` or `gh` on PATH (the spikes put a recording shim there).
import { execa } from "execa";
import type { Config } from "../config.ts";
import { ghHelper, remoteUrl } from "../engine/base.ts";
import { fetchFrom, GitError, openGit, plainCheckout, pushTo } from "../engine/git.ts";
import { commitEvidence, EVIDENCE_BRANCH } from "./evidence-branch.ts";
import type { CiState, Forge, PrComment, Published, ToolkitPrRequest } from "./forge.ts";

export const REVIEW_REQUIRED = "kitchen:review-required";
export const TOOLKIT_LABEL = "kitchen-toolkit";
export const marker = (key: string) => `<!-- kitchen:${key} -->`;

export class GhError extends Error {}

/** Run `gh` with the engine's env. JSON output parsed when `json`. */
export async function gh(args: string[], o: { input?: string; json?: boolean; okExit?: number[] } = {}): Promise<{ out: string; data: unknown; exit: number }> {
  const bin = process.env.KITCHEN_GH_BIN ?? "gh";
  const r = await execa(bin, args, { input: o.input, reject: false, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
  const exit = r.exitCode ?? -1;
  const out = String(r.stdout);
  if (exit !== 0 && !(o.okExit ?? []).includes(exit))
    throw new GhError(`gh ${args.slice(0, 2).join(" ")} failed (exit ${exit}): ${String(r.stderr).trim().split("\n").pop()}`);
  let data: unknown = null;
  if (o.json && out.trim()) data = JSON.parse(out);
  return { out, data, exit };
}

/** Pure: the PR or issue number at the end of a URL gh printed. */
export function numberOf(url: string): number {
  const m = /\/(?:pull|issues)\/(\d+)\s*$/.exec(url.trim());
  if (!m) throw new GhError(`no PR/issue number in ${JSON.stringify(url.trim())}`);
  return Number(m[1]);
}

/** Pure: `gh pr checks --json bucket` rows → one CI state. No rows: none. */
export function ciOf(rows: { bucket?: string; state?: string }[]): CiState {
  if (!rows.length) return "none";
  const b = rows.map((r) => (r.bucket ?? r.state ?? "").toLowerCase());
  if (b.some((x) => x === "fail" || x === "cancel" || x === "failure" || x === "error")) return "fail";
  if (b.some((x) => x === "pending" || x === "queued" || x === "in_progress")) return "pending";
  return "pass";
}

export class GithubForge implements Forge {
  readonly kind = "github" as const;
  readonly repoSlug: string;
  private readonly cfg: Config;
  private readonly repo: string;
  private labelsMade = new Set<string>();
  constructor(repo: string, cfg: Config) {
    if (!cfg.forge.repo) throw new Error("kitchen.yaml: forge.repo (owner/name) is required for the github forge");
    this.repo = repo;
    this.cfg = cfg;
    this.repoSlug = cfg.forge.repo;
  }
  private R = () => ["--repo", this.repoSlug];

  private async push(head: string, branch: string) {
    const git = await openGit(plainCheckout(this.repo));
    await pushTo(git, { url: remoteUrl(this.cfg), refspecs: [`+${head}:refs/heads/${branch}`], helper: ghHelper(this.cfg) });
  }

  private async prFor(branch: string): Promise<number | null> {
    const r = await gh(["pr", "list", ...this.R(), "--head", branch, "--state", "all", "--json", "number,state"], { json: true });
    const rows = (r.data as { number: number; state: string }[]) ?? [];
    return rows.find((x) => x.state === "OPEN")?.number ?? rows[0]?.number ?? null;
  }

  private async labelPr(pr: number, label: string, color: string) {
    if (!this.labelsMade.has(label)) {
      await gh(["label", "create", label, ...this.R(), "--force", "--color", color]);
      this.labelsMade.add(label);
    }
    await gh(["pr", "edit", String(pr), ...this.R(), "--add-label", label]);
  }

  async publish(o: { branch: string; title: string; head: string; body?: string; labels?: string[] }) {
    await this.push(o.head, o.branch);
    let pr = await this.prFor(o.branch);
    if (pr === null) {
      const body = o.body ?? "Opened by Kitchen. The Report and evidence are posted here when the job is ready.";
      const r = await gh(["pr", "create", ...this.R(), "--head", o.branch, "--base", this.cfg.forge.base, "--title", o.title, "--body-file", "-", "--draft"], {
        input: body,
      });
      pr = numberOf(r.out.trim().split("\n").pop() ?? "");
    }
    for (const l of o.labels ?? []) await this.labelPr(pr, l, "B60205");
    return { pushed: true, pr };
  }

  async checks(pr: number | null): Promise<CiState> {
    if (pr === null) return "none";
    // gh exits 8 while checks are pending and 1 when one failed, printing the rows either way.
    const r = await gh(["pr", "checks", String(pr), ...this.R(), "--json", "bucket,name,state"], { json: true, okExit: [1, 8] }).catch((e) => {
      if (/no checks reported/i.test((e as Error).message)) return { data: [] };
      throw e;
    });
    return ciOf((r.data as { bucket?: string; state?: string }[]) ?? []);
  }

  async prMerged(pr: number): Promise<boolean> {
    const r = await gh(["pr", "view", String(pr), ...this.R(), "--json", "state,mergedAt"], { json: true });
    const d = r.data as { state?: string; mergedAt?: string | null };
    return d.state === "MERGED" || !!d.mergedAt;
  }

  async openToolkitPr(o: ToolkitPrRequest): Promise<number> {
    await this.push(o.head, o.branch);
    let pr = await this.prFor(o.branch);
    if (pr === null) {
      const r = await gh(["pr", "create", ...this.R(), "--head", o.branch, "--base", this.cfg.forge.base, "--title", o.title, "--body-file", "-"], {
        input: `${o.body}\n\n${marker(o.key)}\n`,
      });
      pr = numberOf(r.out.trim().split("\n").pop() ?? "");
    }
    await this.labelPr(pr, TOOLKIT_LABEL, "1D76DB");
    return pr;
  }

  async markReady(pr: number | null) {
    if (pr === null) return;
    const r = await gh(["pr", "view", String(pr), ...this.R(), "--json", "isDraft"], { json: true });
    if ((r.data as { isDraft?: boolean }).isDraft) await gh(["pr", "ready", String(pr), ...this.R()]);
  }

  async fileTicket(o: { key: string; title: string; body: string }): Promise<string> {
    const r = await gh(["issue", "list", ...this.R(), "--label", TOOLKIT_LABEL, "--state", "all", "--limit", "200", "--json", "number,body"], { json: true });
    const had = ((r.data as { number: number; body: string }[]) ?? []).find((i) => i.body.includes(marker(o.key)));
    if (had) return `#${had.number}`;
    if (!this.labelsMade.has(TOOLKIT_LABEL)) {
      await gh(["label", "create", TOOLKIT_LABEL, ...this.R(), "--force", "--color", "1D76DB"]);
      this.labelsMade.add(TOOLKIT_LABEL);
    }
    const c = await gh(["issue", "create", ...this.R(), "--title", o.title, "--label", TOOLKIT_LABEL, "--body-file", "-"], {
      input: `${o.body}\n\n${marker(o.key)}\n`,
    });
    return `#${numberOf(c.out.trim().split("\n").pop() ?? "")}`;
  }

  async ticketClosed(ref: string): Promise<boolean> {
    const n = ref.replace(/^#/, "");
    if (!/^\d+$/.test(n)) return false;
    const r = await gh(["issue", "view", n, ...this.R(), "--json", "state"], { json: true });
    return (r.data as { state?: string }).state === "CLOSED";
  }

  /** Comments on a PR or issue (the REST endpoint is shared). */
  async comments(n: number): Promise<{ body: string; user: string; at: string }[]> {
    const r = await gh(["api", `repos/${this.repoSlug}/issues/${n}/comments`, "--paginate"], { json: true });
    return ((r.data as { body: string; user?: { login?: string }; created_at: string }[]) ?? []).map((c) => ({
      body: c.body,
      user: c.user?.login ?? "",
      at: c.created_at,
    }));
  }

  async comment(o: { key: string; pr: number | null; body: string }) {
    if (o.pr === null) return;
    if ((await this.comments(o.pr)).some((c) => c.body.includes(marker(o.key)))) return;
    await gh(["pr", "comment", String(o.pr), ...this.R(), "--body-file", "-"], { input: `${o.body}\n\n${marker(o.key)}\n` });
  }

  async label(o: { key: string; pr: number | null; label: string }) {
    if (o.pr === null) return;
    await this.labelPr(o.pr, o.label, "B60205");
  }

  /**
   * The job's folder on `kitchen-evidence` (W4 builds the bundle, already redacted): the remote's
   * branch is fetched first so the engine's commit (evidence-branch.ts) goes on top of it, then
   * pushed to the explicit URL, never forced (a concurrent publish that won makes this one fail
   * and the stage retries).
   */
  async publishEvidence(o: { key: string; job: string; bundle: string; keepDays: number }): Promise<Published> {
    const git = await openGit(plainCheckout(this.repo));
    const url = remoteUrl(this.cfg);
    const helper = ghHelper(this.cfg);
    try {
      await fetchFrom(git, { url, refspecs: [`+refs/heads/${EVIDENCE_BRANCH}:refs/heads/${EVIDENCE_BRANCH}`], helper });
    } catch (e) {
      if (!(e instanceof GitError) || !/couldn't find remote ref|no such ref|not our ref/i.test(e.stderr)) throw e;
    }
    const r = await commitEvidence({ repo: this.repo, job: o.job, bundle: o.bundle, keepDays: o.keepDays });
    await pushTo(git, { url, refspecs: [`${r.commit}:refs/heads/${EVIDENCE_BRANCH}`], helper });
    return { commit: r.commit, url: `https://github.com/${this.repoSlug}/blob/${EVIDENCE_BRANCH}/${o.job}/`, pruned: r.pruned };
  }

  /**
   * Review comments on a PR, oldest first: the conversation comments and the inline review comments,
   * with GitHub's author_association. Kitchen's own (they carry its key marker) are left out.
   */
  async reviewComments(pr: number | null): Promise<PrComment[]> {
    if (pr === null) return [];
    type Row = { id: number; body: string; user?: { login?: string }; author_association?: string; created_at: string };
    const rows: Row[] = [];
    for (const ep of [`repos/${this.repoSlug}/issues/${pr}/comments`, `repos/${this.repoSlug}/pulls/${pr}/comments`])
      rows.push(...(((await gh(["api", ep, "--paginate"], { json: true })).data as Row[]) ?? []));
    return rows
      .filter((c) => !c.body.includes("<!-- kitchen:"))
      .map((c) => ({ id: String(c.id), pr, author: c.user?.login ?? "", association: c.author_association ?? "NONE", body: c.body, at: c.created_at }))
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /** A PR for a branch the engine made (maintain's Toolkit PR): pushed, then found by branch or opened. */
  async openPr(o: { key: string; branch: string; head: string; title: string; body: string }): Promise<number> {
    await this.push(o.head, o.branch);
    const had = await this.prFor(o.branch);
    if (had !== null) return had;
    const r = await gh(["pr", "create", ...this.R(), "--head", o.branch, "--base", this.cfg.forge.base, "--title", o.title, "--body-file", "-"], {
      input: `${o.body}\n\n${marker(o.key)}\n`,
    });
    return numberOf(r.out.trim().split("\n").pop() ?? "");
  }
}
