---
name: crusaders-mainframe-decisions-night
description: "The admin Night (a member's trace): one fact once, receipts keep their verdict, a refused upload is one refusal at its court, board rows print at the scan, check-in rows are about the organiser, every audit action has a word."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the Night: which rows it reads, and at what instant

The Night is the admin's per-member trace (`TraceKinds`, `AdminMemberTraceAssembly`, `TraceFacts`). How it words and
folds rows is [`decisions-night-words.md`](decisions-night-words.md). Every rule here came from a night that told a
fact twice, told one that did not happen, or put it at the wrong instant.

- **A relay receipt keeps its verdict** (R7, `device_event_receipts.Outcome`, nullable, migration
  `AddDeviceEventReceiptOutcome`; null = written before, read as shown). The night skips `wrong_court`, `unresolved`
  and `unpaired` receipts — each names a booking, none is evidence its court was lit. Too-early and after-cancel are
  kept: the relay ran. *Why:* a refused upload invented "Court 2 lights came on" and counted its minutes as time on court.
- **One lighting, one row.** An uploaded activation writes a receipt (scan time) AND, through settlement,
  `court.lights_on`; the night drops the audit echo when booking, board and event match (nested `occurred_at` within
  1 s, or `seq`); releases match on booking, board, relay. Online lightings have no receipt and keep their row.
  **One instant per lighting** (R19): a receipt with a server `court.lights_on` twin prints at the TWIN's instant — the
  box re-uploads scans answered online with its own clock, which moved the organiser's "lights came on" off every other
  Night once the queue drained; a twinless (offline-only) receipt keeps its own. The release's `court.lights_off` row
  has `ScanAt` = the release instant.
- **Lights rows print at the scan** (R18 E18-7): `CourtLightStateService.Audit` returns the row and callers set
  `ScanAt` (online: the activation's `occurredAt`; upload: the event's `occurred_at`) — the same instant as the receipt
  and the webhook's `occurred_at`. Board (`device.*`) rows print at `occurred_at`, never the upload (R12).
- **A refused activation upload is ONE refusal, at its court, at the scan** (R12 E12-1): the bare `device.activation` row
  is not a person's night (`TraceKinds.OfDeviceAction` → null); its subject is set only when the server refused it, and
  the verdict row `device.activation_{outcome}` says so ("Was refused at Court 2 — the code could not be verified");
  an accepted one is `court.activated` + the receipt. Accepted uploads (`ok`, `reversed_no_show`, `after_cancel`,
  `displaced_collision`) — and a v1 upload's `wrong_court` outcome (R14 D14-3) — carry the member as subject and are `TraceKinds.AcceptedVerdictActions` — never a refusal.
- **A board row's `court` is a RELAY INDEX, never a court** (R12 D12-2): uploads stamp `court_number` from the box's
  relay map; the trace falls back to the relay through the box's map NOW, else names the box ("the court box" for an
  unnamed one, `CourtBoxPlaceholderName`). `detail.court` on a board row is the court number or absent — never the
  relay index (`AdminMemberTraceAssembly.AuditDetail`). Any audit row with no stored court names its `booking_id`'s
  court (R13).
- **Subjects** (R18–R19): check-in rows are about the booking's ORGANISER (`court.activated` stores it; a seat's
  `court.checked_in` maps from `organiser_user_id`, `AdminMemberTraceAssembly.SubjectOf`); the actor is always the
  scanner. Every receipt row's subject is the organiser (JSON + CSV); restore rows too.
- **The sweep's verdict before its money** (R19 E19-5, `NoShowWorker.CauseThenMoney`): `booking.no_show` is stamped
  `CreatedAt = ScanAt = now.Storable()`, the refund/penalty rows 1 µs later — the same rule cancellations keep since R15.
  It is written in the money's own save, about the booker, `peripheral_outage` on an outage, detached on a lost race.
- **A no-show reversed by a late scan records the SCAN** (R8): `ReverseNoShowAsync(…, scan)` stamps the scanner's seat
  (`SeatArrival`, shared with activation) and writes `court.activated` with `ScanAt` = the scan.
- **A collided reversal says so** (R12 E12-4): the reversal audit stores `collision_from` (earliest survivor start) and
  the trace publishes `detail.collision_booking_ids` / `collision_from` — the console links the other booking, never
  the other member's name.
- **The amount column is the viewed member's own money** (R7): a row they only acted on has `amount_minutes: null` and
  the sentence names whose minutes; every share transfer brings its twin (`share:…:out`↔`:in`), the system's automatic
  return included. **The Night never groups money** (R9): a wallet strand, ledger source or amount is its own row.
- **Privacy:** one privacy audit row per VIEW, not per request (`ViewAuditOnce`: same admin, path+query, member within
  30 s; exports never folded), and a night's pages are one view (the fold keys on the query minus `limit`/`cursor`).
  *Why:* StrictMode and retries fetched twice and each wrote an undeletable row. Process-local by design (the single
  backend container is the whole deployment) — on another topology the worst case is the old duplicate, never a lost row.
- **No audit action reads "no word for"** (R18 E18-3): `R18TraceGuardTests` scans the WHOLE API (every audit-shaped
  `const string …Action`, every literal on an `Action = …` line); each must reach a word or
  `TraceKinds.NotAPersonsNight`. *Why the whole API:* the old guard read four named files and `court.lights_restored`
  is written from a fifth. Declared exclusions include the club console's acts (doors shut/reopen/export,
  monitoring resolve/export, member-code phase, retention), `credit.adjusted` (its ledger row is already on the wallet
  strand), `court.extended` (its walk-up twin already says it) and `members.exported` / `no_shows.exported`.
- **Paging:** the console asks 100 events and "Show more" with the cursor for the same day.
