---
name: crusaders-mainframe-decisions-backend-r15a
description: "Backend round 15 (lane BE15a): unreadable bodies are 400 with a code, device UTF-8 read leniently, reversal on covered only by a holder lit at the scan, workers on the injected clock, no self-cancel once checked in."
type: decision
last_verified: 2026-10-05
---

# Live decisions: backend, review round 15 (lane BE15a)

- **A device body is read by `Endpoints/DeviceBody` (a `BindAsync` on each device request record),
  never by the framework's binder** (D15-1). Invalid UTF-8 becomes U+FFFD and the body is parsed:
  a garbled scan is a code nobody holds, so `/events` receipts it and the drain moves on. *Why:*
  a 500 there is "retry" to the firmware: one byte pinned the queue and tripped the breaker. A 400
  on the batch would have dropped the genuine activations behind it. Still not JSON: 400
  `malformed_body`, plus a server `malformed_body` fault (against the board if the bytes name a
  registered MAC, else folded by code: the key holder chooses the bytes).
- **Contract agreed with FW15 (bridge 2.2.5):** a malformed device body is 400 only, never
  401/403/408/429/5xx. The firmware drops the head event on any other 4xx and its breaker counts
  only no-response and 5xx. Corpus court-box requests: 11.
- **A caller's bad body is 400 with a code on every route** (D15-3). `UseStableInternalErrors` sets
  `RouteHandlerOptions.ThrowOnBadRequest = true` in every environment and answers
  `BadHttpRequestException` / a body `JsonException`. Device routes get `malformed_body`; others get
  `invalid_body`, or `bad_request` for a route/query value. 413 is `body_too_large`, 415
  `unsupported_media_type`. *Why:* Development threw (500) while the rest answered an empty 400.
- **A collided reversal's on is suppressed only when the holder was lit at the scan** (D15-2,
  refines R14 E14-4). The test is `LitFrom(holder) <= scan`. If the holder was lit later, the on is
  sent at the scan and the holder's off closes the court. The reversal is cue-stamped either way, so
  no second off. *Why:* the restored end IS the survivor's start, so R14 always suppressed.
- **The workers and the device money are on the injected clock** (D14-4 remnants).
  `LightsCueWorker` and `NoShowWorker` read the container's `TimeProvider`, with no new constructor
  parameter. Device-path ledger rows carry `LedgerPosting.At`, so `CreatedAt` and the `minutes.*`
  `occurred_at` are the act's instant. This covers the walk-up charge and void, the check-in charge,
  reversal legs, the release and lit-cancel charge, displacement, reinstatement and the sweep. The
  rows go through `BookingService.PostOnClockAsync`. Member create/cancel keep the wall (R14).
- **No member self-cancel once checked in** (D15-5): 409 `already_checked_in`. *Why:* the refund is
  0 after attendance and the slot went back on sale, so the club took twice. **The admin route is
  the club** (J15-2): neither this rule nor `already_started` applies, even on the admin's own
  booking. A started session cancels as `cancelled_no_refund` when it was lit.
- `minutes.sold_at_desk` data adds `zar_received` (number, 0 on a gift) and `given`
  (`GivenMinutes.IsGiven`) (E15-5). The named `balance` SSE frame is sent BEFORE its unnamed twin
  (X15-6 server half). An older client then sees the twin as a zero diff.
- **An S4 fixture ("checked in, then cancelled") cancels at the desk.** The money is the same:
  `SettleCancellation` gives (0, 0) whoever cancels, and shares key on Status and `CheckedInAt`.
  Only the words and the record differ. The property's mid-run step desk-cancels only unstarted
  games, so S4 neither shrinks (a 409 was silently swallowed by `Status`) nor widens.
- A pay-for leg names the other member (`LedgerPosting.CounterpartyUserId`, unstored), so each side's
  frame part carries `counterparty_name` (E15-7).
- Tests, each red at HEAD first: `R15DeviceBodyHttpTests`, `R15BE15aHttpTests`,
  `R15BE15aLightsHttpTests`, `DeviceEventHttpTests+R15BE15a`. The S4 fixtures, "checked in and
  cancelled", now cancel at the desk.
