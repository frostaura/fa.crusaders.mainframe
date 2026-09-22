---
name: crusaders-mainframe-gotchas-postgres-offsets
description: "Npgsql refuses a non-zero DateTimeOffset on a timestamptz parameter, and timestamptz keeps only microseconds while DateTimeOffset counts ticks — so an instant can be refused outright or silently altered on the way in."
type: gotcha
last_verified: 2026-09-23
---

# Gotchas — club-local instants and the database

Why a green suite is not evidence is [`decisions-method.md`](decisions-method.md); the rest of
the fixture traps are [`gotchas.md`](gotchas.md).

- **Npgsql refuses to write a `DateTimeOffset` whose offset is not zero** to a
  `timestamp with time zone` column or parameter: *"only offset 0 (UTC) is supported"*. The
  value is not coerced and the query does not run — the request 500s.
- **That makes a club-local instant in a WHERE clause a defect the whole UTC-shaped fixture
  set cannot see.** The doors page computes the club's day boundary in
  `tenant_settings.timezone` and then bounded a range read with it. Every test club in this
  repo runs `"timezone":"UTC"`, where the offset is zero and the bug is invisible; the one
  test written in `Pacific/Auckland` failed on the first run and was the only reason it was
  found before a real club saw it. **Every real club is outside UTC.**
- **The same hole is open on any instant a CLIENT sends.** `?from=2026-09-19T00:00:00+02:00`
  is exactly what a console in a club's own zone produces, and `DateTimeOffset.TryParse` with
  `RoundtripKind` preserves that offset all the way to the parameter.
- **The rule that follows:** `.ToUniversalTime()` at the query boundary, never at the wire
  boundary. The instant is the same either way, but the WIRE should keep the club's offset —
  it is what lets a page say "since 00:00 club time" rather than converting and guessing — and
  the PARAMETER must not. Two call sites carry the comment: `AdminDoorsOverviewEndpoint`'s
  range floor and `DoorLogQuery.Parse`.
- **Testing it needs a non-UTC fixture, not another assertion.** A club in a zone with a
  non-zero offset is the whole test; asserting harder against a UTC club proves nothing. Pick a
  zone whose offset is never zero (`Pacific/Auckland`, `Africa/Johannesburg`) rather than one
  that is zero for half the year.
- **And a fixture's own writes have to be normalised too.** A test that writes an `audit_log`
  row at a club-local instant hits the same refusal from the seeding side and reads as a broken
  endpoint.

## The other half: precision, which fails silently rather than loudly

- **`timestamptz` keeps microseconds. `DateTimeOffset` counts 100-nanosecond ticks, ten to
  the microsecond.** A finer value is not refused and not warned about — the column drops the
  last digit. So an instant stamped from a raw `DateTimeOffset.UtcNow` and ALSO returned in
  that same response is two different numbers: the one the caller was told, and the one that
  persists.
- **It only bites where a value is answered AND re-read.** Shutting a door stamped
  `out_of_service_since`, answered with the in-memory value, and the console's "shut at" then
  moved the first time anybody refreshed — a door reporting an instant it was not shut at.
  Stamps that are only ever read back from the database are unaffected, which is why the ~160
  other `UtcNow` writes in the API are not all defects and were deliberately left alone.
- **`Services/StorableTime.cs` is the fix.** `StorableTime.UtcNow`, or `.Storable()` on a
  value. It truncates, never rounds to nearest — half the readings would otherwise move
  FORWARD, and an event must not be recorded as having happened in the future.
- **It is per-platform, so it passes locally and fails on CI.** The granularity of `UtcNow`
  differs between hosts: the development Macs land on a microsecond boundary often enough to
  survive the round trip by luck, and the Linux runner's finer clock does not. Nothing was
  wrong with the test that caught it.
- **A test comparing one response to a later response cannot see this.** The move happens
  between the answer and the first read, not between two reads. Assert the answered stamp is
  microsecond-aligned, and pin the truncation separately with a value that is guaranteed to
  carry a sub-microsecond tick, so the rule holds on every machine rather than on a clock.
