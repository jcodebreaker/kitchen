// build: write tier. The builder edits the worktree, self-checking through the
// bridge (checks, drive, restart_app, toolkit_status) against the app running
// from its worktree; the engine commits what it left, minus anything the layer
// rules refuse (any Toolkit file, kitchen.yaml and other protected paths, the
// repro's regression test, the test files `test` proofs run, the files Gate's
// checks and the test command run through, a package.json whose `scripts`
// changed), and publishes (local forge in W3a: a branch only).
import fs from "node:fs";
import path from "node:path";
import { builderPolicy, contractOf, filesChecksRunThrough, scriptsChanged, testFilesOf } from "../contract.ts";
import { mergeRev } from "../git.ts";
import { ensureUp } from "../instance.ts";
import { effectiveRisk } from "../machine.ts";
import { once, roundDir, updateJob, writeAtomic } from "../store.ts";
import { changedFiles, commitWith, ensureWorktree, fileAtHead, jobGitOf, pendingFiles } from "../worktree.ts";
import { runBaseCheck } from "./base-check.ts";
import { contractBlock, earlierRoundsBlock, toolkitBlock } from "./context.ts";
import { prompt } from "./prompts.ts";
import { labelsFor, syncFile } from "./ready.ts";
import { headers, runRole } from "./role.ts";
import { hasToolkit } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

/** Ready's pending sync (a conflict with the moved base), if any. */
function readSync(jobDir: string): { base: string; conflicts: string[] } | null {
  try {
    return JSON.parse(fs.readFileSync(syncFile(jobDir), "utf8")) as { base: string; conflicts: string[] };
  } catch {
    return null;
  }
}

/** A file from a round folder as a prompt block, when it exists. */
function fileBlockIf(dir: string, file: string, title: string) {
  const p = path.join(dir, file);
  return fs.existsSync(p) ? [{ title, body: fs.readFileSync(p, "utf8") }] : [];
}

/** Human feedback (`kitchen feedback`) the builder must address, newest last. */
function feedback(jobDir: string): string[] {
  const d = path.join(jobDir, "feedback");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .sort()
    .map((f) => fs.readFileSync(path.join(d, f), "utf8").trim());
}

export const build: StageHandler = async (ctx) => {
  let job = await ensureWorktree(ctx.repo, ctx.refresh());
  const contract = contractOf(ctx.jobDir);
  // A low-risk feature's inline criteria had no spec stage: check them on the base here, before anything is built (flagged only).
  if (contract?.file === "intake.md" && job.kind !== "bug" && job.round === job.roundStart)
    await runBaseCheck(ctx, job, contract.criteria).catch((e) => ctx.log(`base check skipped: ${(e as Error).message}`));
  if (hasToolkit(job) && job.slot) await ensureUp(job, ctx.jobDir, ctx.log).catch((e) => ctx.log(`app not up for the builder: ${(e as Error).message}`));
  // Ready's sync with the base conflicted: the merge is started again here and left in progress
  // (markers in the files, MERGE_HEAD set) for the builder to resolve; the engine's commit below
  // concludes it as a merge commit.
  const sync = readSync(ctx.jobDir);
  let syncing: { base: string; conflicts: string[]; fromBase: string[] } | null = null;
  if (sync) {
    const git = await jobGitOf(job);
    const m = await mergeRev(git, sync.base, { message: `kitchen(${job.id}): sync with the base ${sync.base.slice(0, 12)}`, leave: true });
    if (!m.ok) {
      const mb = (await git.run(["merge-base", "HEAD", sync.base])).stdout.trim();
      syncing = { base: sync.base, conflicts: m.conflicts, fromBase: await changedFiles(job, mb, sync.base) };
      ctx.log(`sync with the base ${sync.base.slice(0, 12)}: the builder resolves ${m.conflicts.join(", ")}`);
    } else {
      ctx.log(`sync with the base ${sync.base.slice(0, 12)}: merged cleanly this time`);
      await updateJob(ctx.repo, job.id, (j) => {
        j.base = sync.base;
        return j;
      });
      fs.rmSync(syncFile(ctx.jobDir), { force: true });
      job = ctx.refresh();
    }
  }
  const fb = feedback(ctx.jobDir);
  const repro = job.reproFiles ?? [];
  const proofFiles = (contract?.criteria ?? []).flatMap(testFilesOf).filter((f) => !repro.includes(f));
  const checkFiles = filesChecksRunThrough([...ctx.config.checkList.map((c) => c.run), ctx.config.test_cmd]);
  const offLimits = [...new Set([...repro, ...proofFiles, ...checkFiles])];
  const r = await runRole(ctx, {
    role: "builder",
    file: "build.md",
    tier: "write",
    prompt: prompt({
      role: "builder",
      job,
      jobDir: ctx.jobDir,
      blocks: [
        contractBlock(ctx.jobDir),
        ...(offLimits.length
          ? [
              {
                title: "Files the proofs run through (you may not create or edit these; the engine puts any edit back)",
                body: [
                  ...offLimits.map(
                    (f) =>
                      `- ${f}${repro.includes(f) ? " (the repro)" : proofFiles.includes(f) ? " (a `test` proof's file: the verifier writes it)" : " (Gate runs through it)"}`,
                  ),
                  "- the `scripts` of any package.json",
                ].join("\n"),
              },
            ]
          : [{ title: "Files the proofs run through (you may not edit these)", body: "- the `scripts` of any package.json" }]),
        ...(syncing
          ? [
              {
                title: "Merge conflict with the base (resolve this first)",
                body: [
                  `The base moved to ${syncing.base.slice(0, 12)} and merging it into this branch conflicts. The merge is in progress in your worktree: resolve the conflict markers in these files, keeping both the base's change and this ticket's, and leave no markers behind:`,
                  ...syncing.conflicts.map((f) => `- ${f}`),
                  "Don't commit: the engine concludes the merge.",
                ].join("\n"),
              },
            ]
          : []),
        ...fileBlockIf(roundDir(ctx.jobDir, job.round - 1), "ci.md", "The PR's CI was red (fix this first)"),
        ...earlierRoundsBlock(ctx.jobDir, job),
        ...(fb.length ? [{ title: "Feedback from a human", body: fb.join("\n\n") }] : []),
        await toolkitBlock(job, job.worktree),
      ],
    }),
    dest: path.join(roundDir(ctx.jobDir, ctx.job.round), "build.md"),
  });
  const h = headers(r.text);
  const status = h.STATUS === "READY" ? "READY" : "BLOCKED";
  job = ctx.refresh();
  const localForge = ctx.forge.kind === "local";
  if (status === "BLOCKED") return { to: "needs-human", facts: { build: { status, committed: false, pushed: false, pr: null, localForge }, why: h.REASON } };
  const pkgs: string[] = [];
  for (const f of (await pendingFiles(job)).filter((x) => path.basename(x) === "package.json")) {
    const now = fs.existsSync(path.join(job.worktree, f)) ? fs.readFileSync(path.join(job.worktree, f), "utf8") : null;
    if (scriptsChanged(await fileAtHead(job, f), now)) pkgs.push(f);
  }
  const policy = builderPolicy({ protectedGlobs: ctx.config.protected, reproFiles: repro, proofFiles, checkFiles, scriptsChanged: pkgs });
  // A merge with the base brings the base's own changes (its Toolkit, kitchen.yaml…): those are the
  // base's, not the builder's, so a file the base changed passes when it is exactly the base's version.
  const fromBase = new Set(syncing?.fromBase ?? []);
  const atBase = new Map<string, string | null>();
  for (const f of fromBase) atBase.set(f, await fileAtHead(job, f, syncing?.base));
  const c = await commitWith(
    job,
    syncing
      ? `kitchen(${job.id}): sync with the base ${syncing.base.slice(0, 12)}, round ${job.round}`
      : `kitchen(${job.id}): round ${job.round}\n\n${job.title}`,
    (file, status) => {
      if (fromBase.has(file)) {
        const p = path.join(job.worktree, file);
        const now = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
        if (now === atBase.get(file)) return null;
      }
      return policy(file, status);
    },
  );
  if (syncing) {
    await updateJob(ctx.repo, job.id, (j) => {
      j.base = syncing.base;
      return j;
    });
    fs.rmSync(syncFile(ctx.jobDir), { force: true });
  }
  if (c.refused.length) {
    for (const x of c.refused) ctx.log(`kept off the job branch: ${x}`);
    writeAtomic(path.join(roundDir(ctx.jobDir, job.round), "build-refused.md"), `${c.refused.map((x) => `- ${x}`).join("\n")}\n`);
  }
  let pushed = false;
  let pr: number | null = job.pr;
  if (c.ahead) {
    const pub = await once(ctx.repo, job.id, `publish/${c.head}`, () =>
      ctx.forge.publish({ branch: job.branch, title: job.title, head: c.head, labels: labelsFor(effectiveRisk(job)) }),
    );
    pushed = !!pub.value?.pushed;
    pr = pub.value?.pr ?? pr;
  }
  return { to: "gate", facts: { build: { status, committed: c.ahead && c.clean, pushed, pr, localForge } } };
};
