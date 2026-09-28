---
name: crusaders-mainframe-decisions-players
description: "D11–D13 (2026-09-23): the booking stays single-payer; shares move as ShareTransfer pairs via one idempotent reconcile off the organiser's Owed; consent caps collection; no debts; partner cap on accept."
type: decision
last_verified: 2026-09-23
---

# Live decisions — players and splits (D11–D13)

The normative spec is `docs/specs/players-and-splits.md`; this is the why.

- **The organiser pays the whole price at booking and every settlement path stays single-payer.**
  *Why:* the settlement model (`decisions-settlement.md`) took rounds to make true; splitting the
  charge itself would have put a new case in every path. A share is a FRACTION OF THE ORGANISER'S
  `Owed`, so cancel/no-show/reversal/displacement/lit-cancelled/release move shares with no code.
- **ShareTransfer is a pair in one save, refs `share:{pid}:{seq}:out|in`, its own `Transfer`
  bucket.** *Why:* nets to zero club-wide and per booking, so no report moves; the global unique
  index on `ExternalReference` makes a raced double-post impossible.
- **One idempotent `ShareLedger.ReconcileAsync`, called after every seat action, after each
  settlement commit via `ShareHook` (callers, fresh scope, never throws) and by `ShareWorker`.**
  *Why:* one place a share is computed; `BookingService` was not edited — the hook sits at the
  endpoints / NoShowWorker / device-event loop. Reversal-displaced and release-reinstated
  bookings are reached by the worker's minute sweep, not the hook (their ids are not surfaced).
- **Lock the DEBITED member only** (partner on collect, organiser on return). Credit never overspends.
  The accept also takes a per-SEAT advisory lock after the member's: two members claiming one open
  link seat hold different member locks and deadlocked (40P01, ~1 in 5 runs of the racing test)
  until it did. Order is always member-then-seat.
- **Every "who is on this booking" subquery goes through `BookingPlayerQueries`** — gate, court box,
  cap, pay-for — so P7's `IBookingPlayers` roster seam wires to it in one line.
- **Consent caps collection; lowering a share lowers consent; raising needs a new accept.** *Why:*
  otherwise a share lowered then raised back would be re-debited without asking.
- **No debts.** A collection the partner cannot cover is simply not posted; after the deadline
  (SOLD end + `share_lapse_hours`) it lapses and the organiser's cover stands. *Why:* Playtomic's
  worst habit is a ledger of debts between friends. Only an admin collect with
  `allowNegativeBalance` + reason may overdraw a partner; admin accept-on-behalf records NO consent.
- **Late-cancel penalty is the organiser's alone** (cancelled without check-in → partners 0);
  **no-show penalty is shared pro rata**. Rounding is toward zero per seat so partners never sum past Owed.
- **Split rounding: partners floor to whole credits, organiser takes the remainder.** Removing/declining
  never auto-resplits — the organiser absorbs the freed share.
- **D12 cap: accepted seats count against the partner's own cap**, checked on the first accept of a
  future game under the partner's lock (the cap's unit). Peak/windows/price bind the organiser only.
- **A payer override on a split booking is silently ignored** (the scan still checks in); pay-for
  (P7) must refuse with `split_pay_in_app` via `ShareLedger.IsSplitAsync`.
- **Invite tokens are shown once, hashed at rest; member invite mails link `/invites/{pid}`, never
  a token** — a token in an outbox payload would be a clear-text credential.
- **Member mail rides the R23 outbox with `Audience`/`RecipientUserId`** rather than a second
  outbox; quiet hours re-checked at delivery (a deferral hands back the attempt). Admin feed filters Audience = Admins.
- **Preferences: `findable` / `show_in_leaderboards` (P2 names) stay canonical**; D13's
  `findable_in_directory` / `show_on_leaderboards` are accepted aliases; `share_results` stored only.
- **Migration `AddBookingParticipants` Down refuses once a ShareTransfer exists** (dropping them would
  change balances) and deletes member-audience outbox rows (they would read as admin mail).
