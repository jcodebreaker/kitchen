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
import { openGit, plainCheckout, pushTo } from "../engine/git.ts";
import { EVIDENCE_BRANCH, publishEvidence } from "./evidence.ts";
import type { CiState, Forge, ToolkitPrRequest } from "./forge.ts";

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

  private async label(pr: number, label: string, color: string) {
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
    for (const l of o.labels ?? []) await this.label(pr, l, "B60205");
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
    await this.label(pr, TOOLKIT_LABEL, "1D76DB");
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

  async pushEvidence(o: { key: string; job: string; dir: string }): Promise<string> {
    await publishEvidence({
      repo: this.repo,
      url: remoteUrl(this.cfg),
      helper: ghHelper(this.cfg),
      job: o.job,
      jobDir: o.dir,
      keepDays: this.cfg.forge.evidence_keep_days,
    });
    return this.evidenceUrl(o.job);
  }

  /** Where a job's evidence folder is browsable. */
  evidenceUrl(job: string, file?: string): string {
    return `https://github.com/${this.repoSlug}/${file ? "blob" : "tree"}/${EVIDENCE_BRANCH}/${job}${file ? `/${file}` : ""}`;
  }
  rawUrl(job: string, file: string): string {
    return `https://github.com/${this.repoSlug}/raw/${EVIDENCE_BRANCH}/${job}/${file}`;
  }
}
