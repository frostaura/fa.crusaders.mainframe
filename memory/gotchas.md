---
name: crusaders-mainframe-gotchas
description: "The test suite lies in specific ways: no fixture read a real socket, a test can be green for its fixture, in-memory EF proves the opposite, a mutation that does not apply looks like a pass. Clock traps live in gotchas-clock."
type: gotcha
last_verified: 2026-09-21
---

# Gotchas — the test suite and its fixtures

Why a green suite is not evidence at all is a decision, not a gotcha:
[`decisions-method.md`](decisions-method.md). Every trap whose hidden input is the wall clock is in
[`gotchas-clock.md`](gotchas-clock.md).

- **NOTHING HERE READ A RESPONSE THE WAY THE BOARD DOES, and round G3 found what that hides.**
  Every firmware HTTP fixture is a string a fake hands over, and `test/e2e-device/scenario.py`
  talks to the real API through `urllib`, **which de-chunks and closes for you** — so the one
  thing neither could see was the FRAMING. The real API answers `Transfer-Encoding: chunked` on
  a keep-alive connection, and a reader that was correct against every invented fixture timed
  out on **every** call against the actual server: no roster, and a door that refused everyone.
  The firmware fixtures are real captured bytes now; `door_evening.py` reads over a raw socket
  (1.0, and 1.1 de-chunked by hand, direct and through nginx) at `DW`, and at `DSIM` it runs the
  REAL door firmware over a real socket — so a FRAMING regression goes red at the first and a
  DECISION one at the second. `scenario.py` still uses `urllib`, which proves neither.
- **A test can be green because of its FIXTURE, not its code.** Flipping one boolean on a stale
  device fixture exposed a live money rule — a stale-but-enabled box beside a healthy one waiving
  no-show penalties indefinitely — that no test discriminated. Mutate the rule *and* vary the
  fixture.
- **A concurrency test on the EF in-memory provider proves the opposite of what it claims.** That
  provider has no transactions (it says so, via `TransactionIgnoredWarning`) and applies changes
  entry by entry, so a `SaveChanges` that fails a concurrency check has *already inserted* the
  ledger rows before it throws. A double-cancel test asserting a balance of 200 got 232 — one
  `NotFound` and two committed refunds at once. Anything resting on one `SaveChanges` being one
  transaction belongs in the Postgres-backed suite: the in-process `TestHost` is in-memory,
  `TestWebAppFactory` + `PostgresFixture` is not.
- **A mutation that does not apply looks exactly like a passing gate.** Shell escaping inside a
  `python3 -c` one-liner silently made an edit a no-op, so good tests appeared to prove nothing.
  Use a heredoc and confirm the mutant is present before believing the result.
- **`Program.cs` captures the connection string at `AddDbContext` registration**, which under the
  minimal hosting model runs *before* `ConfigureAppConfiguration` hooks fire. Config layered on by
  `WebApplicationFactory` never reaches it; environment variables do. That is why the test factory
  sets them — do not "simplify" it back.
- **`BackgroundService.StartAsync` no longer runs `ExecuteAsync` inline on .NET 10.** It schedules
  it, and an immediate `StopAsync` can return before the task is even assigned. A test that starts a
  hosted service and asserts on what it did must poll with a deadline; asserting straight after
  reads the pre-start state and looks like a service bug.
- **GitHub sets `CI=true` in every job**, including ones with no database, so keying a "must not
  skip" assertion on it fails the jobs it meant to leave alone. The boundary tests key on
  `REQUIRE_BOUNDARY_TESTS`, and without a connection string in that variable's partner they skip
  **silently** — a green run that tested nothing.
- **After deleting a feature, run the browser suite, not just the unit suites.** An e2e spec covered
  the discovery-and-claim flow for weeks after the flow was removed from the product, red in a
  required job the whole time.
