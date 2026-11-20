---
name: crusaders-mainframe-decisions-lights-cues
description: "The booking.lights_on/off mirror: one lights_on source, every off said when the court is next free under a per-court lock, lit-cancelled bookings cued off, reversal on/off a pair or nothing, one instant per lighting."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the lights cues a webhook consumer reads

Spec: `docs/specs/webhooks.md` (`booking.lights_off`, *Ordering the lights events*); code `Webhooks/LightsCueWorker.cs`,
`Services/CourtActivationService.cs`, `Services/CourtCueLock.cs`. A consumer mirrors one court's state from these;
every rule below exists because a mirror built on the earlier one read a paid court dark or a dark court lit for ever.

- **`CourtActivationService` is the one `booking.lights_on` source** (activation, walk-up, pay-for, the reversal);
  `LightsCueWorker` only ever emits `booking.lights_off` (`LightsCueTests` pins "no lights_on event at all").
  `booking.lights_on`'s actor and `data.identified_user_id` are the scanner (organiser, accepted partner or payer);
  `user_id` stays the owner, `paid_by_user_id` who paid. **A late check-in's reversal EMITS `booking.lights_on`**
  (`EmitReversedLightsOnAsync`) — the webhooks contract already listed "roster fallback uploaded later" as a source.
- **One court's cues are serialised by `CourtCueLock`** — `pg_advisory_xact_lock(0x43554520, fnv(tenant, court))`
  (`CourtCueLock.cs:40`), the TWO-int key space, disjoint from every bigint lock (`PayerLock`, seat, device,
  admin-role). The sweep holds it across read → decide → save → SEND, then commits; every lights_on is sent under it
  AFTER its check-in committed (`EmitUnderCueLockAsync`, `:671`; the reversal takes the lock directly, `:601`). So a
  check-in committing mid-sweep is seen lit (no off) or announces its on after the off. Innermost lock: holders take no
  other advisory lock, emitters hold no row locks, no HTTP under it. *Cost:* the off is sent before the sweep commits,
  so a commit failing after a good save re-sends it next tick. `NextFreeAsync` reads untracked (a tracked row answers
  with pre-lock state). Proof: `R13LightsCueRaceHttpTests` (`AfterOffDecidedForTests`).
- **Every `booking.lights_off` is said when the court is next free** (R13): `LightsCueWorker.NextFreeAsync` walks forward
  from the booking's end; `occurred_at` = the end when no LIT booking holds the court, the off is withheld while a lit,
  not-yet-cued holder holds it (its own off closes the court later), and a holder already over and cued off moves the
  stamp to its end, chained. `LightsOffCuedAt` is set either way, so nothing re-fires. *Why:* back-to-back slots, and a
  collided reversal's restored end, meet the next member's early `lights_on` — an off stamped at the tick read their
  paid session dark.
- **A lit booking holds the court from `min(StartsAt, CheckedInAt)`** (R14 D14-1; `NextFreeAsync` is `internal static`,
  takes no `now`, reads every booking with `CheckedInAt` set whose end is past the instant, ordered by when lit). *Why:*
  reading only STARTED bookings missed a member who scanned in early across a gap. A scan after the previous end still
  leaves the gap dark — the off goes out at the earlier end.
- **A lit booking that is then cancelled is cued off at its `EndsAt`** (D14-2; cancel never moves `EndsAt`), stamped
  by the same walk under the lock, never promoted, never sent `booking.completed`; it is also a HOLDER in the walk,
  because its relay runs on (statuses read: Booked, Completed, NoShow, Cancelled with `CheckedInAt`,
  `LightsCueWorker.cs:265-268`). **Bounded to `EndsAt` within `CancelledLitLookback` (2 h, `:58`)** in SQL — without it
  the first deploy sent every consumer a stale off for each historical row. The query is a seq scan; the fix if it ever
  matters is a partial index `WHERE "LightsOffCuedAt" IS NULL` (a migration). An UNLIT cancelled booking gets no off;
  no cancellation fires an immediate off (`lights-controller.md` marks that old sentence superseded).
- **A cancelled relit reversal is swept like any lit cancellation** (D16-4: `Cancelled && CheckedInAt &&
  NoShowReversedAt > LightsOffCuedAt`, inside the lookback) and counts as a holder whose off is still to come; so does
  a relit reversal still Booked and reversed after its old cue.
- **Reversal on/off are a pair or nothing** (R14 E14-4, narrowed R15 D15-2): the reversal's on is suppressed only when a
  holder was lit AT the scan (`LitFrom(holder) <= scan`); if the holder lit later, the on is sent at the scan and the
  holder's off closes the court. The reversal is cue-stamped (`LightsOffCuedAt` ≥ `NoShowReversedAt`) either way, so the
  attended-and-over pass owes no second off. *Why:* the restored end IS the survivor's start, so R14 always suppressed,
  and an on stamped at the scan arriving after the survivor's never got an off. A reversal AFTER the off cue gets one
  more `lights_off` at the restored end (`CompleteAttendedAsync` restamps `LightsOffCuedAt`).
- **Consumer rule that covers what source cannot:** order by `occurred_at`; an off that ARRIVED before the on of the
  same booking does not close that on (the no-show sweep's off was said before the upload reversed it).
- **One instant per lighting** (R19 E19-2): `occurred_at` of every `booking.lights_on` is the scan instant the Night
  prints (`data.scanned_at` = it), UNLESS an off for the court was already said after the scan and the session still
  runs — then it is stamped at emission (`ReversalOnAtAsync`, `CourtActivationService.cs:496,608`; R16 E16-2), so a
  consumer ordering by `occurred_at` never reads the court dark after an off. An over session keeps the scan stamp (an
  on stamped now would sort after its past off and hold the court lit for ever).
- **Webhook actors:** `minutes.*` and `booking.created` `actor.is_admin` is the actor's `User.IsAdmin`, read
  (`LedgerService.HoldsAdminAsync`; `BookingService.cs:914`), never `actorId != userId` — that called a member paying
  for a friend's court at the box an administrator. `minutes.sold_at_desk` carries `zar_received` (0 on a gift) and
  `given`; reversal mirror names follow the sign (`minutes.refund_reversed` / `minutes.penalty_returned`,
  [`decisions-settlement.md`](decisions-settlement.md)).
