---
name: crusaders-mainframe-decisions-doors-log
description: "The club door log and its export: the club's day computed on the server, a half-open range built at midnight's own offset, clamped to retention, no member field in the request at all, and a CSV that defuses before it quotes."
type: decision
last_verified: 2026-09-21
---

# Live decisions — the club door log, its day and its export

The surface these belong to is [`decisions-doors-console.md`](decisions-doors-console.md); the
oracle is `docs/specs/door-gate.md` §13.

- **Today is the CLUB's day, computed on the server, and `null` when it cannot be established.**
  *Why:* a count taken in a browser is a different day for an admin travelling or with a wrong
  device clock, and it is the number somebody quotes in a committee meeting. A zone the platform
  does not know reaches this through a hand-edited column, and rendering that as `0` is the
  admin-failed-read defect wearing a number.
- **The range is half-open and the club's day is built at MIDNIGHT's own offset** (`DoorClock`).
  *Why:* closed at both ends, a scan at a club's midnight fell in yesterday AND today — two
  answers to "how many came through last night" from one set of rows. And `DoorDay` used the
  offset at *now*: the same every day in UTC and Johannesburg, wrong on a DST change.
- **The log's request type has no member field**, and unknown query parameters are ignored
  rather than refused. *Why:* the rule is P3's, and a refusal would confirm which names the
  server recognises. A test drives `member`, `user`, `subject`, `q` and `search` through it and
  asserts the bytes are identical.
- **The range is clamped to the club's retention, not merely defaulted to it.** *Why:* the page
  states that number and the rows survive on disk between nightly sweeps, so answering past it
  would make the page's own sentence false.
- **The CSV defuses, then quotes — in that order.** A cell starting `= + - @` is a formula, and
  a door's name, a member's name and a gate key are all club-entered. Quoting first leaves it a
  formula once the reader strips the quotes. The value is kept and prefixed, never stripped, so
  a door genuinely named `-Side` survives.
