---
name: crusaders-mainframe-gotchas
description: "The test suite lies in specific ways: no fixture reads a real socket, it cannot pass in the last half-hour of a UTC day, the door evening was red for an hour a day, some tests cannot fail on this Mac, a test can be green for its fixture."
type: gotcha
last_verified: 2026-09-21
---

# Gotchas — the test suite and its fixtures

Why a green suite is not evidence at all is a decision, not a gotcha:
[`decisions-method.md`](decisions-method.md).

- **The suite cannot pass in the last ~30 minutes of a UTC day.** Six tests go red together — one
  in `WalkUpBookingTests` and five in `DeviceEventHttpTests` — all from one cause: a 30-minute
  purchase truncated at the club's midnight close and the pro-rata price that follows. CI is green
  only by the hour it happens to run. **Reproduce a red run on the untouched base commit in a
  second worktree before believing your diff caused it.** Sweeping for these means running under
  several synthetic clocks — and moving the club timezone in the test host alone manufactures false
  failures unless every fixture pinning `"timezone":"UTC"` moves with it.
- **A fixture reset that names a status is racing every worker that changes one.**
  `door_evening.py` cleared the seeded bookings `where "Status" = Booked`; the seeder plants one
  at **18:00 local** and `NoShowWorker` sweeps every 30 s, so an evening starting after 18:01
  had it written off to `NoShow`, `EndsAt` truncated, in the same seconds.
  `ck_bookings_no_overlapping_slot` excludes `Cancelled` and **nothing else**, so the corpse
  stayed in the constraint and D8's back-shift over the slot that had just ended was refused:
  one step red and four behind it. It clears every status.
- **A test booking `UtcNow.AddHours(3)` fails every afternoon.** The fixture's peak window is
  16:00–19:00 UTC and a Regular member may not take a peak slot that far ahead, so a cancellation
  test throws `PeakHoursLeagueOnly` and reads as a broken refund path. `BookableSlot()` steps clear
  of the window; `BookableSlotFrom(now, hours)` exists so a fix is tested at all 24 hours.
- **Some tests cannot fail on this Mac, by construction.** `DateTimeOffset.UtcNow` here always
  lands on a 100 ns boundary, so a sub-microsecond remainder that survives differently through
  Postgres on Linux cannot arise locally — one test was red on five CI runs at four different hours
  and green here every time. Diagnosing it needs the CI log and a deliberately tick-offset fixture,
  not another local run. **`-v q` suppresses the assertion message in CI**, leaving only `[FAIL]`
  and a name; pass `-v n` when a CI-only failure has to be read rather than guessed.
- **NOTHING HERE READ A RESPONSE THE WAY THE BOARD DOES, and round G3 found what that hides.**
  Every firmware HTTP fixture is a string a fake hands over, and `test/e2e-device/scenario.py`
  talks to the real API through `urllib`, **which de-chunks and closes for you** — so the one
  thing neither could see was the FRAMING. The real API answers `Transfer-Encoding: chunked` on
  a keep-alive connection, and a reader that was correct against every invented fixture timed
  out on **every** call against the actual server: no roster, and a door that refused everyone.
  The firmware fixtures are real captured bytes now, and `test/e2e-device/door_evening.py` reads
  over a raw socket (HTTP/1.0, and 1.1 de-chunked by hand, direct and through nginx);
  `scenario.py` still uses `urllib`. A client that handles the protocol for you proves neither.
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
