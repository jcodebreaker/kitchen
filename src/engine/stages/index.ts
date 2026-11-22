// One handler per active stage.
import type { Stage } from "../machine.ts";
import { build } from "./build.ts";
import { drives } from "./drives.ts";
import { gate } from "./gate.ts";
import { intake } from "./intake.ts";
import { ready } from "./ready.ts";
import { report } from "./report.ts";
import { repro } from "./repro.ts";
import { review } from "./review.ts";
import { spec } from "./spec.ts";
import { toolkit } from "./toolkit.ts";
import type { StageHandler } from "./types.ts";
import { verify } from "./verify.ts";

export const HANDLERS: Partial<Record<Stage, StageHandler>> = { intake, spec, repro, build, gate, drives, verify, toolkit, review, ready, report };
