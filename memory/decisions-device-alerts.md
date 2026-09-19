---
name: crusaders-mainframe-decisions-device-alerts
description: "How a board reports on itself: one outage mail per cooldown derived from the rows, silence about any board no admin has acknowledged, a cap of 16 unacknowledged rows answered 409, and a door that is never a court's evidence."
type: decision
last_verified: 2026-09-19
---

# Live decisions — what a board may tell the club about itself

Who a door opens for is [`decisions-gate-access.md`](decisions-gate-access.md). Oracle:
`docs/specs/door-gate.md` §8, and `settlement-model.md` S5a for the waiver.

- **`device_alert_cooldown_minutes`** — tenant setting, default 60, range 5–1440, error
  `device_alert_cooldown_minutes_out_of_range`, both spellings bound on the PUT and ALWAYS present
  in the GET (the console's type carries no client-side default, so a conditional key is a
  settings page that cannot render on the day a club's boards misbehave). *Why:*
  `PeripheralHealthWorker` had no cooldown and no minimum outage, so every transition mailed every
  admin — a board flapping on a marginal uplink filled the mailboxes until somebody muted the
  sender, and an alert nobody reads is worse than no alert because the club believes it has one.
  It bounds a FLAPPING board and nothing else; the fleet is bounded by the two rules below.
- **Announcement is DERIVED from the outage rows, not stored on them.** The board's rows are
  replayed in order and each is announced iff the cooldown has elapsed since the last ANNOUNCED
  one — not since the last row, which would let a board flapping just inside the window chain past
  it for ever. *Why derived:* a column would be an EF migration for a notification decision, and
  the rows are immutable, so the same replay at close time returns what it did at open time. A
  recovery mail is therefore sent only if its outage mail was. **Known cost, accepted:** a club
  that changes the setting mid-outage may get an all-clear for an alarm it did not get.
- **A board NO ADMIN HAS ACKNOWLEDGED mails nobody, whatever kind it is** (`AutoRegistered`). The
  first version exempted an unnamed GATE only, and **the flood was never a door problem**: a gate
  is the one kind that must be named before it does anything, while a `kind`-less heartbeat
  registers a **court box** with no naming step at all — mailable from the instant it exists. So
  twelve invented MACs were twelve mails to every admin in one tick, and the cooldown does not
  touch it, because twelve boards are twelve FIRST outages. `AutoRegistered` means exactly "nobody
  has looked at this row"; the first admin edit clears it. The gate's naming rule survives as the
  narrower of the two: `gate_key` is what makes the message identify a door. The outage ROW and
  the `peripheral.*` events are still written.
- **A club may hold at most `MaxUnacknowledgedDevices = 16` boards nobody has acknowledged**; past
  it auto-registration answers **409 `too_many_unacknowledged_devices`** and creates no row. It
  counts the UNACKNOWLEDGED rows: a cap on the total would eventually refuse a club that really
  has forty boards, at the worst moment. It bounds **creating** a row, never serving one, so a
  flood cannot take a club's installed doors offline. **409 and not 403**, because on that group
  a 403 means "out of service" and the firmware commits an empty roster on one — the 403 mutant
  is killed by `DeviceForbiddenMeansOutOfServiceTests` as well as by the new test.
- **Taking a board out of service closes its open outage silently, at the switch instant.** The
  sweep skips disabled rows, so an outage open at that moment stayed open for as long as the board
  was out of service; switch it back on and the first heartbeat mailed the whole club "back after
  43 200 minutes" about a board they had themselves unplugged. Closed at the switch because that
  is the last moment the club was accountable, and because every settlement instant after it is
  decided by `OutOfServiceSince` (`DeviceOutageIndex.DoorWasShutFor`), so no deadline is re-priced.
  **Residual:** a board disabled while HEALTHY, unplugged, and re-enabled a month later still
  opens a fresh outage reaching back to its true last heartbeat — a true figure; the artefact was
  the outage that SPANNED the disabled period, and closing it is what removed it.
- **A door is never a court's evidence, by rule rather than by accident.** `DeviceOutageIndex`
  read every device row with no filter on kind; a gate stayed out of the court index only because
  auto-registration leaves `CourtNumbers` empty. Filtered to `Kind == CourtBox`, because a court
  number on a gate row — a fixture, a restore, a migration — makes a silent DOOR waive no-show
  penalties on a court it does not drive. `AdminConfigEndpoints` was already filtered.
- **`PeripheralHealthWorker.TickAsync` and `NoShowWorker.TickAsync` take a stated instant**, and
  the tests drive the REAL workers rather than reconstructing them — flapping is invisible in any
  single tick, and the acknowledgement rule only shows at twelve boards from `AutoRegisterAsync`.
