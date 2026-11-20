---
name: crusaders-mainframe-decisions-method
description: "Quality here is proven by refutation, not by a green suite: every fixer is followed by an agent paid to disprove it, rounds repeat until two consecutive ones find nothing high, and parallel lanes are scoped by FILE, never by theme."
type: decision
last_verified: 2026-11-20
---

# Live decisions — how quality is proven here

- **A passing suite is evidence about the tests, not about the code.** Three separate adversarial
  passes have now found real, live defects in code carrying hundreds of green tests — an IDOR any
  logged-in member could use, registration writing rows outside every tenant, a front panel that lit
  the wrong court, a cross-member wallet leak through a service worker. Several were invisible *by
  construction*: the button decode lived in a `main.cpp` that both the host test runner and the
  strict-compile gate skip. When the fix is "move the logic somewhere the tests can see it", that is
  the fix, not a tidy-up on the side.
- **Every fixer is followed by an independent refuter** whose job is to disprove the fixer's own
  report and to mutate each fix until its test is shown to pin something. This has caught a live
  money rule whose only test had stopped discriminating it, six sentences fixers had written into
  specs claiming something was impossible or absent, and the privacy leak above. *Why it is worth
  the cost:* a fixer reporting on itself is the single most reliable source of false closure here.
- **Mutate the rule AND vary the fixture.** A test can be green because of one SETUP field rather
  than the code under it. Varying a single fixture flag exposed a stale-but-enabled box waiving
  no-show penalties indefinitely — a rule no test discriminated.
- **Rounds repeat until two consecutive ones find nothing critical or high** (founder, 2026-09-06:
  "repeat this loop till youre happy, no matter how many rounds"). *Why:* each round of fixes
  changes the product and the changed product has its own defects — a majority of one round's highs
  were regressions introduced by the previous round's fixes.
- **Scope parallel lanes by FILE, never by theme.** Two lanes independently redesigned the same
  admin table and shipped contradictory tests about one element; two independently-correct fixes for
  "notify an admin on registration" merged into two emails per application, past an assertion using
  `Contains`, which passes on duplicates. Assert counts where duplication is the failure mode.
- **A green run on the founder's Mac is not a green run.** Some tests cannot fail here by
  construction and only fail on Linux CI; others fail in wall-clock windows. Both are in
  [`gotchas-clock.md`](gotchas-clock.md), and the rule that follows is: reproduce a red run on the **base
  commit in a second worktree** before believing your diff caused it.
- **Delivery went straight onto `main`** (founder, 2026-09-23 — it replaced "one branch, one PR"), so every push ran
  CI's release half too; since PR #12 (2026-11-13) the larger passes have landed as branches and PRs merged when green —
  which is now the rule is an open question ([`questions.md`](questions.md)). **Fix everything found, related or not**,
  with adversarial rounds rather than a fixed number of passes, until the founder calls a stop. P10 stopped after round
  19 at Dean's request ("wrap up after this round") with **0 of the 2 quiet rounds** asked for (highs/mediums R16 H1 M8 ·
  R17 H0 M7 · R18 H1 M5 · R19 H0 M4, ~30 LOW); every R19 finding was fixed and **no fresh review has verified the R19
  fixes**. The 2026-11-13 ironclad pass ran nine lanes plus a second integration under "fix any and all".
- **Lanes that build against a spec rather than against each other disagree, every time** (ironclad, both passes): the
  console and the API on v3 device fields, the door's replay `reason` vs the server's `cause`, the emitter's key/net
  objects vs the gate's vocabulary, the register/verify contract, a money route with no console. Each was found only by a
  test that reads the OTHER side's source or real replies (`deviceV3Wire.contract.test.ts`, `make device-replay-check`,
  shared corpus vectors) — stubbed suites were green on all of them. And some things are found only by running every
  gate on the MERGED tree: nine functions over the complexity gate from a lane that never ran it, a bridge `loop()` over
  its 4 KB stack, and `scenario.py`'s glass steps that had never run (E-LCD-3 asserted the Mega 2.1.0 screen and aborted,
  so "148/150" hid six steps; a 16-cell marquee window not covering the court matched any figure — the predicate now
  needs the item wholly in view).
- **The lint gate stays strict and the loader idiom carries per-site disables.** React-hooks errors
  were fixed for real where the rule caught genuine impurity; the recurring fetch-on-mount loader
  got `eslint-disable-next-line` with a stated reason at each site. *Why not a config downgrade:*
  it would silence the rule for all future code in a money-handling product.
- **A gate that never runs is indistinguishable from one that always passes.** Three CI gates here
  were incapable of failing — an `|| exit 0`, a coverage gate that exited 0 when no report was
  produced, and a security scan unreachable behind a permanently red job, which found real
  advisories the moment it became reachable. Do not add a fourth escape hatch; `make test-iot`
  fails hard when the toolchain is missing for exactly this reason.
- **One review is kept on disk as evidence, and the rest were session artefacts.**
  `docs/reviews/adversarial-e2e-review.md` (2026-08-24) stays because its finding ids are the
  dictionary that `make test-e2e-device`'s steps and `docs/go-live-checklist.md` decode against.
  The three later rounds' reports were deleted 2026-09-11: everything they raised was either closed
  or superseded by the device-contract simplification, and their durable content is in these topics.
  **A report is not a memory** — promote the finding, then delete the file.
