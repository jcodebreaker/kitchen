# W3b spikes: Toolkit stage, forge, Ready, benchmark

Asserting scripts. Each prints `PASS`/`FAIL` lines and exits 1 on any miss; results are in `results.md`. Every script makes its repos under the scratch dir you give it (default `spikes/w3b/.work/`, ignored), with its own `KITCHEN_HOME`. Nothing touches your repos, `~/.kitchen` or GitHub.

**GitHub without GitHub.** The forge and ticket source run against `gh-shim.mjs`: a fake `gh` put first on `PATH` (and named in `KITCHEN_GH_BIN`) that records every call (`calls.jsonl`) and serves PRs, checks, comments, labels and issues from a state file the spikes edit (mark a PR merged, turn CI red). Pushes and fetches go to a local bare repo standing in for GitHub's git, through engine git to the explicit URL with `--receive-pack`/`--upload-pack` (ADR 0006). `lib.ts` builds both.

```sh
node spikes/w3b/forge.ts <scratch>          # no agent, no Docker (~5 s): GitHub forge + issue source + evidence branch against the shim
node spikes/w3b/ready.ts <scratch>          # scripted agent, Docker (~12 min): CI pending → paused(ci), red CI → build, sync conflict → build → done
node spikes/w3b/toolkit.ts fake <scratch>   # scripted agent, Docker (~6 min): the toolkit stage with a scripted smith that writes a real `sql` primitive
node spikes/w3b/toolkit.ts claude <scratch> # REAL agents on Claude (sonnet strong, haiku medium): the same job, the smith included
node spikes/w3b/docker-guard.ts <scratch>   # Docker, one small image (~1 min): an unmerged bin/dev's Docker goes through the guard (ADR 0008, M5)
node spikes/w3b/oracles.ts <scratch> [ticket…]  # no agent: every benchmark oracle FAILS on the base; planted bugs' oracles PASS with the plant taken out
KITCHEN_GH_TEST_REPO=<owner>/<throwaway> node spikes/w3b/github-live.ts --yes-this-repo-is-throwaway <scratch>
                                            # NOT RUN by the build: the forge.ts sequence against a real throwaway GitHub repo
```

`W3A_VERBOSE=1` prints every CLI line. Claude runs `/opt/homebrew/bin/claude` unless `KITCHEN_CLAUDE_BIN` is set.

## The benchmark

`kitchen bench smoke|full|tuned|heldout [--tool claude|codex] [--runs n] [--only a,b] [--concurrency n] [--max-usd x] [--out dir]` runs `bench/set.yaml` (see that file and `bench/README.md`), scores each run against its expected outcome and hidden oracle, appends one `bench` line per run to the ledger of the repo it is started in, and writes `bench/results/<date>-<tier>-<tool>.md` and `.json`. `kitchen report --bench` prints the runs in the ledger.

## Scripted agents

`fake-agent.ts` wraps `spikes/w3a/fake-agent.ts` (fixture A with the planted dark-mode bug) and adds: reviewers that PASS (W4 builds the lenses), a builder that resolves the conflict markers a sync left by taking the base's side and then makes w3a's fix, and `scenario: primitive` (intake rates it high; the spec's only proof reads the database through a `sql` primitive the Toolkit lacks; the smith writes a real, generic, read-only `sql` primitive in its own worktree; the builder adds the column and sets it on sign-in).
