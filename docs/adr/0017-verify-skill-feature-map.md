# A verify skill with a feature map: Kitchen keeps how to check the app, not a pile of tests

**Status.** Accepted, 2026-11-23, by the user, after the explainer page and video ("good, go ahead"). Builds on ADR 0016. The shape comes from poteto's pstack skills `create-verification-skill` and `maintain-verification-skill` and from `poteto/verification-skill-example` (all MIT © 2026 Lauren Tan, credited in NOTICE). Putting code locations in the feature map comes from public write-ups of Dune's feature map (XiaoHu, newsfilter).

## Why

The 4-ticket run (2026-11-23) went through 20 criteria:
- QA checked 8 `page` criteria in a browser and kept none of them;
- only 3 of its scripts even survived, as files in a gitignored job folder;
- job 003 redid its whole QA three times, for merge conflicts, not bugs;
- only the unit tests the builders wrote were kept: 8 tests became 15.

So every QA run starts from zero, and nothing checks earlier features again when new code lands. The user doesn't want a growing pile of saved e2e tests either. They want tools that change with the app and that agents keep current.

## Decision

### 1. A verify skill in the repo
`kitchen init` writes `.claude/skills/verify-<app>/` (and the same skill for Codex under `.agents/skills/`). It is committed with the rest of Kitchen's files.

**`SKILL.md`** has five sections, filled from what init already detects. No agent is involved.
- **Launch:** `kitchen qa up`, plus the start command, the port and the reset.
- **Doctor:** the health URL, and that the port belongs to us.
- **Drive:** `kitchen qa page`, `kitchen qa http`, and the stable handles to prefer (roles, labels, ids).
- **Evidence:** what to capture and where.
- **Cleanup:** `kitchen qa down`; it never removes evidence.

**`features/README.md`** has:
- the index;
- the baseline preconditions (seed users, reset);
- the driving conventions;
- the sweep order.

**`features/<feature>.md`:** one file per user-facing feature. It opens with a title and one paragraph, then four headings in this order:
- `Sub-features`: short ids, one line each;
- `How to get to it (user POV)`;
- `Driving it with kitchen qa`: preconditions, then action → exact command → result you can see;
- `Gotchas`.

It ends with **`Code:`**, the files or folders behind the feature.

Init seeds no feature files. The first QA that touches a feature writes its file.

### 2. QA uses and keeps the map
- **What the brief carries:** the map's index, plus the feature files whose `Code:` paths match the job's files (intake's FILES and, after Build, the diff).
- **What QA does:** it follows those recipes and checks the job's criteria. Then it updates the map in the job's QA folder under `map/`:
  - new sub-features;
  - changed selectors or commands;
  - new gotchas;
  - a new feature file when the job adds a feature.
- **Admission:** QA never commits. At `job finish` Kitchen copies `map/` into the job branch as a Kitchen commit, and review sees it in the diff.
- **Builders don't touch `verify-*/`.** A build that changes it is refused.

### 3. Before a merge into staging
- Kitchen takes the changed files of the merged result, matches them to `Code:` lines and lists the features they touch.
- QA drives those features' recipes on the merged result in the trial-merge worktree, not only the job's own criteria. That's how one job breaking another is caught.
- **Result:**
  - a red recipe sends the job back to Build with the recipe and its evidence;
  - no matching feature means no extra drive.

### 4. Weakening a recipe is refused in code
If a job's map change removes a sub-feature, a recipe step or an expected result, `job finish` refuses it. The exception is a `CHANGES: <feature>/<sub-feature>` line from intake, traced to the ticket's words: the ticket changes that behaviour on purpose. The Report shows every such change as "Changed earlier check: was …, now …".

### 5. Later rounds re-drive, they don't re-explore
In round 2 and later, when the criteria didn't change and the last QA passed, the QA brief says to re-drive the recipes and the criteria from the map. It doesn't explore from zero.

### 6. Keeping the map small and current
- **The map grows with features, not tickets.** A ticket updates the file of the feature it touches.
- **`kitchen verify maintain`** (on demand, or `/kitchen` can suggest it every N merges) is one agent session:
  - prune features that no longer exist;
  - merge duplicates;
  - fix drift, by reading each feature's `Code:` paths and driving it live;
  - sort every finding as doc drift (fix the map), a harness gap (fix the recipe) or a product regression (file a **new Kitchen ticket**; never weaken the map);
  - land its result through a job, like any change.
- **`kitchen verify sweep`** (at the release cut, before a person merges `staging` into `main`):
  - drives every feature in the README's sweep order, against `staging`;
  - writes a sweep report with evidence;
  - changes nothing.

## Not taken
- **A saved spec per criterion, replayed on every merge** (Fable's first proposal). It grows with tickets, and the specs go brittle.
- **Playwright's own planner, generator and healer agents.** They need `@playwright/test` and a config in the user's repo. Their healer rule is kept: fix how to reach something, never what is expected.
- **The old Toolkit's contract, proof and approval** (ADR 0016 removed them).

## Consequences
- QA gets faster as the map fills in, and the map is a readable description of the app for people too.
- **Code enforces:**
  - which features are driven before a merge (`Code:` matching);
  - that builders don't edit the map;
  - that recipes aren't weakened without `CHANGES:`.
- **Prompts guide:** recipe quality and choosing selectors.
- **Merges into staging get a little slower:** they drive the touched features, one merge at a time.
- **A wrong `Code:` line means a feature isn't driven when it should be.** `verify maintain` and the release sweep are the backstop.

## Amendment, 2026-11-23: how it is built

**§3, the drive before a merge, is a fifth lane: `regress`.**
- After review passes (and the job isn't held at Ready), Kitchen does the trial merge it always did (staging's tip plus the reviewed head, in `.kitchen/merge/<id>`, the checks run there). Then it lists the touched features: the files that merge changes (`git diff <staging tip> <merged>`) against the `Code:` lines of the map in the merged result.
- None: it merges, as before. Some: nothing lands. The job moves to the `regress` stage with the trial merge kept (worktree, and a ref `refs/kitchen/drive/<id>` so the commit survives), and the orchestrator starts a regress lane like any other: one agent, `roles/regress.md`, the touched features' files whole in its brief, `kitchen qa` against the merged checkout, evidence and `verdict.json` (one row per feature) in `rounds/<n>/regress/`.
- `kitchen job finish`: a red row sends the job back to Build (a new round, or a person when out of rounds), and the next builder's brief quotes the failing feature, the note and the evidence. Green lands that exact merge commit when staging hasn't moved (compare-and-swap, as before). If staging moved meanwhile, Kitchen merges again; when the new merge touches features, the lane drives it again (no new round).
- So Kitchen's code decides which features are driven, an agent drives them (recipes are prose), and the verdict gates the merge. The regress lane runs on the QA model. The dashboard shows it in the Review column as "Merge check".
- Every job that touches a mapped feature gets a regress lane, its own new feature included: the merged result is the thing that lands, and only driving it catches one job breaking another. A job held at Ready skips it: a person merges that one.
- Not chosen: driving the touched features inside the QA lane (QA runs on the job branch, before review and before staging moves; it already follows the touched recipes, as a guide), or holding the merge lock while an agent drives (minutes of every other merge waiting).

**§2, admission.** QA writes whole feature files (and `README.md`) in `<qa folder>/map/`; there is no delete (pruning is `verify maintain`'s). Only a passing QA's map is admitted: Kitchen checks each file against the contract (an H1, the four H2s in order, sub-feature ids, steps, a `Code:` line), then the weakening rule, then copies the files into both tools' copies of the skill in the job's worktree and commits them as Kitchen. A refusal sends QA again with the reason in its brief. If staging has no verify skill yet (init's files weren't committed), the first admission brings Kitchen's skeleton with it. The QA brief's files are intake's `FILES:` plus the diff since the job's base.

**§2, builders.** At `job finish` after Build, Kitchen takes the branch's net change to `.claude/skills/verify-*/` and `.agents/skills/verify-*/` since the job's base, less the paths Kitchen's own map commits wrote; anything left refuses the build. A change put back is no change. Reviewers catch a builder rewriting a file Kitchen admitted, and the backstop below refuses it if it weakens a check.

**§4, the weakening rule** (code: `src/verify/map.ts`, tested in `map.test.ts`). Over the markdown structure only:
- a sub-feature is its bullet's id (a leading code span, else the word before a colon); it is removed when no bullet in the newer file has that id;
- a recipe step is a bullet of `Driving it with …` outside the `Preconditions:` list, keyed by its bold label (else its whole text); it is removed when no step in the newer file has that key;
- a step's expected result is its text after the sentence with its command (`Run `…``), else its last sentence; it is changed when the same step's reads differently (whitespace and case aside);
- a removal is allowed when `CHANGES:` names it: the sub-feature itself; for a step, a sub-feature the step names in a code span, or any sub-feature of its feature when it names none.
- QA's map is compared with the map at the job's base (staging at its last catch-up). The same check runs once more on the whole branch before the merge, as a backstop (a weakening found there sends the job back to Build).
- Allowed changes are kept in the job folder (`map-changes.json`) and the Report lists each as "Changed earlier check (CHANGES entry): item: was …, now …". Intake's brief now lists the map's features and sub-feature ids, so it can write `CHANGES:`.

**§5, re-drive.** QA's start snapshots the criteria into its QA folder. In a later round, when the last QA folder with a verdict passed and its snapshot equals the criteria now, the QA brief has "Re-drive, don't re-explore" with that round's rows (notes and evidence; its scripts are in that folder).

**§6, sweep and maintain** are thin runs, not jobs: `kitchen verify sweep|maintain` checks out staging under `.kitchen/verify/<run>/` (maintain on a branch `kitchen/verify-<run>`), starts the app, writes the brief and prints the agent's prompt; the `/kitchen` skill starts one agent with it; `kitchen verify finish <run>` reads the result. `kitchen qa … <run>` drives a run's app like a job's. The sweep writes `report.html` and changes nothing. Maintain's finish refuses a branch that changes anything outside the verify skill, and any removal (by the rule above) that `report.json` gives no reason for; it mirrors the skill for Codex, then lands the branch through the merge gate jobs use (trial merge, checks, compare-and-swap; left for a person when `staging.auto_merge` is off). Product regressions are filed by the agent with `kitchen ticket`. Not chosen: maintain as a Kitchen job (its builder may not touch `verify-*/`, and intake's criteria don't fit an upkeep pass).

**§1, init.** The skill is named `verify-<package.json name, without a scope>` (else the folder's name); an existing `verify-*` skill keeps its name. Each generated file ends with a marker holding the hash of what Kitchen wrote: init refreshes a file only while it still matches, so a file a person or QA changed is never overwritten. The Codex copy follows the Claude copy. The Drive section lists the ids, labels, test ids and field names init finds in the page code.
