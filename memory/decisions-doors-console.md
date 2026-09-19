---
name: crusaders-mainframe-decisions-doors-console
description: "The admin doors surface: one vocabulary for four audit actions, the club's own day with a null that is never zero, a log with no member filter by construction, a formula-safe export, and a fleet shut that reopen-all can undo."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the admin doors console

Oracle: `docs/specs/door-gate.md` §13, which carries the sentence→test table. The member half
and the purge are [`decisions-doors-member.md`](decisions-doors-member.md). What a door decides
is [`decisions-gate-access.md`](decisions-gate-access.md); the board's own contract is
[`decisions-gate.md`](decisions-gate.md), untouched — **no device route gained anything**,
because a `403` on `/api/v1/device/*` may mean one thing only.

- **One vocabulary, stated once, because six readers ask it.** Four audit actions are a scan at
  a door — `gate.opened`, `gate.denied_<reason>`, `device.gate_open`, `device.unknown_scan` —
  and two of them released a lock. `DoorTrail` owns that set for the club log, the CSV, the
  per-door counts, both signals, the member's history and the retention sweep. *Why:* a fifth
  door action added later would otherwise become five different subsets of the truth, and the
  first reader somebody forgot would silently under-count a club's day. A `device.registered` or
  `device.updated` is the BOARD's story and stays in the per-board feed: nobody stood at the door.
- **The per-board projection moved rather than being copied.** `DoorActivityView` holds the six
  field rules the club log now also needs. *Why:* one of them decides whether a string is a
  fingerprint or a live access code, and two copies of a privacy check is one too many. The
  per-board feed is still exactly six keys, pinned, because WIRE-W1 lists it unchanged.
- **Today is the CLUB's day, computed on the server, and `null` when it cannot be established.**
  *Why:* a count taken in a browser is a different day for an admin travelling or with a wrong
  device clock, and it is the number somebody quotes in a committee meeting. A zone the platform
  does not know reaches this through a hand-edited column, and rendering that as `0` is the
  admin-failed-read defect wearing a number.
- **Two numbers per door, never one, and no sort parameter — ever.** *Why:* one headline on a
  sortable list of doors is a footfall ranking by accident, the shape the spec's §1 prevents.
- **A signal has nowhere to put a member.** Four fields: kind, since, until, scans. *Why:* the
  rows it derives from name members, and at a club of two hundred a credential is a person. A
  structural absence beats a convention; the test serialises the payload and greps it. Three
  grants in sixty seconds is a contract constant, not a setting — a club tunes the refusal spike
  to its traffic, not the smallest count at which a stuck lock beats "scanned and walked away".
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
- **`reopen-all` is an undo, not an unlock, and `Device.ShutByShutAllAt` is the only thing that
  can say so.** A door an admin shut individually stays shut through a fleet reopen. *Why:* they
  shut it for a reason this system knows nothing about, and reopening it would be the product
  overruling a person at a door. One unit of work, because the console's "nothing was shut,
  every door is exactly as it was" is true only while there is a single save.
- **The door card is measured, never inferred.** `power_loss_behaviour` defaults to
  `not_established`, the honest state of every door in the field, and the PATCH refuses anything
  outside the closed set. *Why:* a board with no power drives nothing, so no firmware flag bears
  on it — [`watch-doors.md`](watch-doors.md) holds the two facts Carl still owes.
- **Wave 2's remote open, passes and propped-open land here**, and anything that adds a door
  action must join `DoorTrail` in the same change or it is outside every reader at once. Delete
  this topic when the doors console stops being a distinct surface from the devices one.
