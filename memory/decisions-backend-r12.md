---
name: crusaders-mainframe-decisions-backend-r12
description: "Backend, review round 12 (lane BE12): refused uploads are refusals at the scan and court, one wallet frame per action, the scanner is named, a late lights_on is at the scan and gets its off."
type: decision
last_verified: 2026-10-04
---

# Live decisions — backend, review round 12 (lane BE12)

- **A refused activation upload is ONE refusal, at its court, at the scan** (E12-1). The bare
  `device.activation` row is not a person's night (`TraceKinds.OfDeviceAction` → null): its subject
  is set only when the server refused it, and the verdict row `device.activation_{outcome}` says so
  ("Was refused at Court 2 — the code could not be verified" / "— no booking of theirs on that court
  then"); an accepted one is `court.activated` + the receipt. *Why:* forged, bookingless and replayed
  uploads read "Checked in at 0". Board (`device.*`) rows print at `occurred_at`, never the upload.
- **A board row's `court` is a RELAY INDEX, never a court** (D12-2). Uploads now stamp
  `court_number` from the box's relay map; the trace falls back to the relay through the box's map
  NOW, else names the box ("the court box" for the `CourtBoxPlaceholderName`). `detail.court` on a
  board row is the court number or absent. Offline refusal: "Was refused at Court 2 while its box
  was offline" — never "refused … refused offline".
- **The LCD name** (D12-1, `MemberDisplay`): `"`/“” → `'`; `\` and `~` separate words (A00 ROM ¥, →);
  the initial is the first LETTER of the LAST word ("PRIYA B" for "… van der Berg").
- **Door CSVs** (D12-3) name gates through `TraceKinds.DoorLabel` — "Unnamed scanner (gate-…)".
- **One action, one wallet frame per member** (X12-1, contract C1). `WalletFrameHolds` (singleton,
  keyed tenant+booking, reached via `RealtimeOutbox.Holds`) + `WalletFrameScope`: the desk, member
  and bulk cancel endpoints hold the booking's frames across the `ShareHook` follow-up's scope;
  release sends one: reason = first (primary), delta = net, parts = every row. Every frame has
  `cancelled_by` ("club" when an admin cancels somebody else's court, else "member"; null on
  non-cancellations). A frame is held only when every row names the held booking. *Why:* refund +30
  then share −15 toasted twice, 70 ms apart, from two commits in two scopes.
- **The scanner is named** (E12-2, C2): reversal legs carry unstored `LedgerPosting.CheckedInBy`; the
  attended share's `ShareWhy.CheckedInBy` is the seat stamped at `booking.CheckedInAt`, else the booker.
  Frames carry `checked_in_by_name` (null when it was the frame's own member); the reversal mails say
  "Sam Partner checked in after all", "You were … after all" only to the scanner.
- **I12 amended** (E12-3): the reversal's `booking.lights_on` is at the SCAN (duration scan → restored
  end). A reversal AFTER the off cue gets one more `booking.lights_off` at the restored end, in
  `LightsCueWorker.CompleteAttendedAsync`, restamping `LightsOffCuedAt`. Spec edit asked of the integrator.
- **Collision** (E12-4, C3): the reversal audit stores `collision_from` (earliest survivor start); the
  trace publishes `detail.collision_booking_ids` / `collision_from`. No admin booking view exists server-side.
- Tests: `R12NightActivationHttpTests`, `R12CancelFrameHttpTests`, `R12DoorCsvColumnsTests`,
  `MemberDisplayTests`, `R9OutageReversalHttpTests` (partner scan), `LightsCueTests`, `+LateActivation`.
  Each red first or mutation-checked. Full suite 3513/3513 on 2026-10-04.
- **Environment, 2026-10-03:** Docker Desktop died under load ~257 ("unable to start"; `crusaders-test-pg`
  went into recovery mid-run). The lane ran on a private Homebrew `postgresql@15` cluster in the
  scratchpad on :5441 (`initdb --locale=C`, `unix_socket_directories=''` — the scratchpad path is past
  the 103-byte socket limit). btree_gist is the only extension needed; pg15 ran the whole suite green.
