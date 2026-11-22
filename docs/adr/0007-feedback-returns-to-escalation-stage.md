# Feedback returns to the stage the job escalated from

When a job goes to needs-human, the engine records the stage it left (`escalatedFrom`), and `kitchen feedback` sends it back to that stage with a fresh round budget, not always to build: a job that escalated from intake, spec or repro would otherwise skip its spec or its reproduction, and one stuck in verify or report would rebuild for nothing. The operator can name another stage with `kitchen feedback <id> --to <stage>`, and the machine refuses any other target with the reason. Jobs from before this change, and `done` jobs, go to build.
