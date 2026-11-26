# Bench results

One row per run of `npm run bench` (bench/README.md says what each column means). `dry` rows ran the stand-in agent: they prove the pipeline and the oracles, never Kitchen's quality.

| date | mode | Kitchen | preset | oracle pass | merged | needs you | rounds | wall | $ | per ticket | file |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-26 | dry | a4bd256 | cheap | 10/10 | 7 | 1 | 7 | 0m 13s | $0.00 | search ok, members-me ok, renew ok, healthz-version ok, returned-stuck ok, zero-copies ok, families ok, check-limit ok, request-id ok, push-main ok | 2026-11-26-a4bd256-cheap-dry.json |
| 2026-11-26 | dry | 9c5d6a6 | cheap | 10/10 | 7 | 1 | 7 | 0m 15s | $0.00 | search ok, members-me ok, renew ok, healthz-version ok, returned-stuck ok, zero-copies ok, families ok, check-limit ok, request-id ok, push-main ok | 2026-11-26-9c5d6a6-cheap-dry.json |
| 2026-11-26 | real | 9c5d6a6 | cheap | 9/10 | 7 | 1 | 7 | 7m 25s | $2.11 | search ok, members-me ok, renew ok, healthz-version ok, returned-stuck ok, zero-copies ok, families ok, check-limit FAIL, request-id ok, push-main ok | 2026-11-26-9c5d6a6-cheap.json |
