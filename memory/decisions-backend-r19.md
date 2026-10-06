---
name: crusaders-mainframe-decisions-backend-r19
description: "Backend round 19 (lane BE19): two-board device bodies filed against no board; power-dip restore once per boot; one instant per lighting on every Night and the webhook; a seatless pay-for payer paid and lit."
type: decision
last_verified: 2026-10-06
---

# Live decisions: device bodies, review round 19 (lane BE19)

- **A body naming two boards is filed against neither (D19-4).** `DeviceBody.FileAsync` collects every
  distinct board MAC the request named (`DeviceBody.BoardsNamed`: the limiter's charged MAC, every `"mac"`
  in the raw text including nested ones, every top-level `mac` in any case, read as far as the bytes parse;
  non-MAC values skipped; at most 4). One → filed against that registered board, detail unchanged. Two or
  more → filed against no board (the club's folded `malformed_body` row) with
  `"<route>: <detail> (boards named: <mac>, <mac>)"` — stored lowercase hex.
  **Why:** R18 D18-5 refused the body but filed it against the FIRST-named MAC, so box-then-gate blamed the
  box and gate-then-box the door for a body either may have sent; "the charged board" is no better, since the
  charged MAC is just the first `"mac"` the regex saw. Same rule for an unreadable (cut) body naming two.
- `TopLevelMacs` now tolerates a body that stops parsing (returns what it read); `NamesTwoBoards` only ever
  calls it on parsed JSON, so its D18-5 behaviour is unchanged.
- Console: the two-board detail is not in `deviceFaultCopy.ts`'s `BODY_FAULT` table, so it renders as the raw
  detail (as R18's `TwoBoardsDetail` already did). A cut body naming two boards no longer maps to the
  "dropped" explanation line for the same reason.
- Tests: `R19DeviceBodyHttpTests` (8 two-board shapes red before the fix; 4 one-board controls).

- **One restore per boot (E19-1).** The box's `restored_relays` is set once per boot and rides EVERY later beat
  unchanged (bridge `applyRestore`, `gRestoreDone`); the server read any `> 0` as a confirmation, so a steady box
  re-confirmed every beat and the fresh-boot window re-served the plan — a `court.lights_restored` row per lit
  court per beat and `OnSince`/`Cause` overwritten. Now (`Endpoints/RestoreBoot.cs`): boot = server clock − the
  board's uptime; new column `devices.RestoreServedBootAt` (migration `AddDeviceRestoreServedBootAt`) keeps the
  served boot after settlement. Settle only with `RestoreServedAt` set AND the served boot == this boot (±3 s);
  an expectation from an earlier boot is dropped without a verdict (rebooted before answering — not a failure);
  never serve a boot already served or one whose count is already > 0. Unknown uptime (absent/negative/>10 y)
  reads as the same boot (pre-R19 behaviour). **Why a column, not reuse:** the served boot must survive the
  settle that clears `RestoreServedAt`, and an estimate from serve time alone mis-reads a reboot seconds later.
- **Out-of-range `restored_relays` (outside 0–255, the firmware's byte) settles nothing**; the expectation waits.
  Not 400 (a diagnostic counter must never take the roster down), not clamp (a clamped 9e18 would "confirm").
  `no_push`/`events_lost` were already clamped into int; `uptime_ms` out of range gives no boot.
- **Restore rows are about the organiser (E19-4):** `RelayRestoreItem.OrganiserUserId` (= `booking.UserId`) is the
  audit subject; the light state's `CausedByUserId` stays the payer (`PaidByUserId ?? UserId`).
- Test model fixed: `DeviceRelayRestoreHttpTests` walks boots on a movable clock with the count sticky per boot.

- **One instant per lighting (E19-2).** An activation receipt with a server `court.lights_on` twin prints at the
  TWIN's instant (`ReceiptAtOf`) — the box's queue re-uploads scans answered online with its own clock, which moved
  the organiser's "lights came on" off every other Night's instant once it drained. A twinless receipt (offline
  only) keeps its own. Every receipt row's subject is the booking's organiser (`ReceiptRow.OrganiserUserId`;
  JSON + CSV). The release's `court.lights_off` row now has `ScanAt` = the release instant (= its receipt's).
- **Partners who played see lights off:** `LightsOffAction` joins `TraceKinds.PartnersViewActions` /
  `OfPartnersView` / `IsLightsRow` (same accepted-partner-or-payer gate as lights on).
- **`booking.lights_on` `occurred_at` = the Night's instant** for every activation (`CourtActivationService`
  passes `occurredAt`, `scanned_at` = it), unless an off for the court was said after it and the booking still
  runs — then now (`ReversalOnAtAsync`, the R16 E16-2 rule, so a consumer ordering by `occurred_at` never reads
  the court dark after an off). Was the service's second clock read, 60–200 ms after the row.
- **A seatless pay-for payer paid and lit (E19-3 wording):** `court.activated` whose `payer_user_id` is the actor,
  on somebody else's booking, with no accepted seat (`Strands.AcceptedSeats`) → `TraceFacts.PaidAndLit`:
  "Pam Payer paid for Court 2 at the court box and lit it" / own Night "Paid for Court 2 at the court box and lit
  it for Olga Organiser's booking". Kind stays `court.checked_in` (frontend landmark list keys on it). With a seat:
  "checked in" as before. Counting (AttendanceQuery/PlayersQuery) is BE19c's.
