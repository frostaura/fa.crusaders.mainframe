---
name: crusaders-mainframe-decisions-device-alerts
description: "How a board reports on itself: one outage mail per cooldown derived from the rows, no mail for a gate nobody named, a silent close at disable time, and a door that is never a court's evidence."
type: decision
last_verified: 2026-09-19
---

# Live decisions — what a board may tell the club about itself

Who a door opens for is [`decisions-gate-access.md`](decisions-gate-access.md). Oracle:
`docs/specs/door-gate.md` §8, and `settlement-model.md` S5a for the waiver.

- **`device_alert_cooldown_minutes`** — new tenant setting, default 60, range 5–1440, error
  `device_alert_cooldown_minutes_out_of_range`, both spellings bound on the PUT and ALWAYS present
  in the GET (the console's type requires it and carries no client-side default, so a conditional
  key is a settings page that cannot render on exactly the day a club's boards misbehave).
  *Why:* `PeripheralHealthWorker` had no cooldown and no minimum outage, so every transition
  mailed every admin — a board flapping on a marginal uplink filled the mailboxes until somebody
  muted the sender, and an alert nobody reads is worse than no alert because the club believes it
  has one. Auto-registration makes that a capability rather than a nuisance: anyone with the club
  key can mint boards that each do it.
- **Announcement is DERIVED from the outage rows, not stored on them.** The board's rows are
  replayed in order and each is announced iff the cooldown has elapsed since the last ANNOUNCED
  one — not since the last row, which would let a board flapping just inside the window chain past
  it for ever. *Why derived:* a column would be an EF migration for a notification decision, and
  the rows are immutable, so the same replay at close time returns what it returned at open time.
  **Known cost, accepted:** a club that changes the setting mid-outage may get an all-clear for an
  alarm it did not get, bounded to the boards in outage at that instant.
- **A recovery mail is sent only if its outage mail was.** An all-clear for an alarm nobody was
  given is noise about an event the club never heard of.
- **A gate no admin has named mails nobody** — D3's acknowledgement applied to alerts, for the same
  reason it was applied to the roster. The outage ROW and the `peripheral.*` events are still
  written: the Devices page is where an admin looks at a board on purpose, so what is withheld is
  the interruption, not the record.
- **Taking a board out of service closes its open outage silently, at the switch instant.** The
  sweep skips disabled rows, so an outage open at that moment stayed open for as long as the board
  was out of service; switch it back on and the first heartbeat mailed the whole club "back after
  43 200 minutes" about a board they had themselves unplugged. Closed at the switch rather than at
  the last heartbeat because that is the last moment the club was accountable — and because every
  settlement instant after it is decided by `OutOfServiceSince`
  (`DeviceOutageIndex.DoorWasShutFor`), so no deadline is re-priced by the close.
  **Residual:** a board disabled while HEALTHY, unplugged, and re-enabled a month later still
  opens a fresh outage reaching back to its true last heartbeat. That figure is true, the named
  artefact was the outage that SPANNED the disabled period, and closing it is what removed it.
- **A door is never a court's evidence, by rule rather than by accident.** `DeviceOutageIndex`
  read every device row with no filter on kind; a gate stayed out of the court index only because
  auto-registration leaves `CourtNumbers` empty. Filtered to `Kind == CourtBox`, because a court
  number on a gate row — a fixture, a restore, a later migration — makes a silent DOOR waive
  no-show penalties on a court it does not drive, and a healthy door veto the §6a waiver a member
  is owed. `AdminConfigEndpoints`' button-map check was already filtered; that was the only other
  reader.
- **`PeripheralHealthWorker.TickAsync` and `NoShowWorker.TickAsync` take a stated instant.** The
  flapping behaviour is invisible in any single tick, so the tests drive the REAL workers across
  hours of injected clock rather than reconstructing what they do.
