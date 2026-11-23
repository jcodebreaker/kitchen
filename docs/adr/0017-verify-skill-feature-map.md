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
