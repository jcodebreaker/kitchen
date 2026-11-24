// Where `kitchen verify sweep|maintain` runs live: .kitchen/verify/<run>/ with the checkout it drives (wt/), its
// evidence (evidence/), the app's state (app.json) and run.json. `kitchen qa … <run>` takes a run id in place of a job.
// A collect's triage (ADR 0022, `triage-…`) gets a checkout of staging here too, to reproduce reports on.
import path from "node:path";
import { kitchenDir } from "../engine/store.ts";

export const RUN_ID = /^(sweep|maintain|triage)-\d{8}-\d{6}$/;
export const isRunId = (ref: string) => RUN_ID.test(ref);
export const runsDir = (repo: string) => path.join(kitchenDir(repo), "verify");
export const runDir = (repo: string, id: string) => path.join(runsDir(repo), id);
export const runWorktree = (repo: string, id: string) => path.join(runDir(repo, id), "wt");
export const runEvidence = (repo: string, id: string) => path.join(runDir(repo, id), "evidence");
