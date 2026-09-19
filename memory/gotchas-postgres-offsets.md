---
name: crusaders-mainframe-gotchas-postgres-offsets
description: "Npgsql refuses any DateTimeOffset with a non-zero offset on a timestamptz parameter, so a club-local instant thrown at a query is a 500 for every club outside UTC while every UTC fixture stays green."
type: gotcha
last_verified: 2026-09-19
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
