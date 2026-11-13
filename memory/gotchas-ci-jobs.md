---
name: crusaders-mainframe-gotchas-ci-jobs
description: "CI job-level traps: a timeout reports as CANCELLED and names no test, a failed job silently SKIPS the suites behind it, and a threshold applied to the tier that cannot satisfy it reads as a product regression."
type: gotcha
last_verified: 2026-09-29
---

# Gotchas — the CI jobs themselves, not the tools they run

The lint and complexity tooling inside these jobs has its own traps:
[`gotchas-gates.md`](gotchas-gates.md).

- **A job killed by `timeout-minutes` reports `conclusion: cancelled`, not `failure`.** It
  names no test and points at nothing, so it reads like a hang or like somebody pressed
  cancel. Two jobs ended this way in one night and neither was hung. **Before diagnosing a
  cancelled job, check its elapsed time against its budget.**
- **A watch that only reports completed jobs cannot tell a hang from a long run.** Silence
  looks identical either way. A CI monitor must emit a heartbeat naming what is still running
  and for how long, or a 40-minute job burns 40 minutes before anybody learns anything.
- **A red unit shard hides a stale e2e suite, and it grows with every merge.** Frontend shards 1 and 3
  failed from #6 (2026-11-07) and every UI change merged behind them ran no Playwright at all: PR #12
  then found ~70 stale or broken specs at once, plus five real layout regressions. Treat a red
  `frontend` job as blocking merges, not as noise — the cost lands on whoever greens it.
- **Playwright shards with many failures get CANCELLED, not failed**: every failure retries once and
  records video, and the shard runs out of its 30 minutes before printing the list. Run the failing
  files locally (`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium` in a cloud container) rather than
  waiting for a cancelled shard to say what broke.
- **A failing job silently SKIPS every job behind it**, so "the rest was green" can mean "the
  rest never ran". `backend-integration`, `e2e-device` and `security` all sat skipped behind
  two red jobs for several runs, which hid the state of three suites — including the device
  chain, which had never executed on that code at all. **Count the skips before reading a run
  as mostly-passing.**
- **The coverage threshold belongs on `backend-integration`, not on `backend`.** The fast job
  has no Postgres, so every database-backed test skips itself — 1017 of 2209 — and a 70% rule
  applied there measured how much of the product is reachable *without a database*. It read
  63.2% and failed a release whose real coverage is **94.1%**. A threshold a tier cannot
  structurally satisfy teaches people to edit the threshold.
- **Collecting coverage costs about 35% of the runtime.** The same suite is 12m34s without it
  and 17m with. That is what pushed `backend-integration` past a 25-minute budget the day the
  gate moved there; it is 40 now. **Moving a step into a job changes what that job costs — move
  its budget too.**
- **The vitest suite grows faster than its budget.** On the 4-core runner the unsharded test
  step went 10m12s → 13m46s in one day (P11 + fixes) and the job was cancelled at 15 min with
  every step green. Since 2026-09-29 `frontend` is a 3-shard matrix (`vitest --shard=i/3`;
  lint and build on shard 1 only). **A big feature lane adds minutes to CI — check the step
  times, not just the conclusion.**
- **Playwright retries record video**, so a handful of genuine failures can cost more wall
  clock than the whole passing run and tip a job over its limit. A cancelled Playwright job is
  usually a real failure wearing a hang's clothes: read the first `✘` rather than the kill.
