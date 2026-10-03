---
name: crusaders-mainframe-decisions-night-truth
description: "Review round 7 backend: a night tells one fact once and only the viewed member's money; receipts keep their verdict; the payer at the box reads what they paid for; package_free at the desk."
type: decision
last_verified: 2026-10-03
---

# Live decisions — what the night, the reports and the desk say (review round 7, lane BE)

Tests: `R7ChainHttpTests`, `R7WordsTests`, `DeviceEventHttpTests+R7Night`, `DeskSaleHttpTests`,
`PeripheralHealthTests.An_outage_refund_says…`. Commits 47c24f66, cdf281c8, 06a06ab8.

- **A relay receipt keeps its verdict** (`device_event_receipts.Outcome`, nullable, migration
  `AddDeviceEventReceiptOutcome`; null = written before, read as shown). The night skips
  `wrong_court`, `unresolved` and `unpaired` receipts — each still names a booking, none is
  evidence its court was lit. *Why:* a refused upload invented "Court 2 lights came on" and
  counted its minutes as time on court (E7-1). Too-early / after-cancel are kept: the relay ran.
- **One lighting, one row.** An uploaded activation writes a receipt (scan time) AND, through
  settlement, `court.lights_on` (upload time). The night drops the audit echo when booking,
  board and event match (nested `occurred_at` within 1 s, or `seq`); releases match on booking,
  board, relay. Online lightings have no receipt and keep their row.
- **The sweep writes `booking.no_show`** (system, about the booker, `peripheral_outage`) in the
  money's own save, detached on a lost race. An outage refund's ledger reason is "Court N was
  offline — booking refunded in full" (wallet, ledger, `minutes.refunded`), never "No-show".
  `SweepOneAsync` sits at lizard's ceiling (length 200, CCN 15): extract before adding.
- **The amount column is the viewed member's own money.** A row they only acted on carries
  `amount_minutes: null`; the sentence names whose minutes and how many. Every share transfer
  brings its twin (by `share:…:out`↔`:in`), the system's automatic return included (E7-3).
- **Doors on a night use the console's rule** (`TraceKinds.DoorLabel` = `doorDisplayName`):
  current name by device id, never the "Door gate" placeholder, else "Unnamed scanner (code)".
- **Role `payer`** (D10 pay-for): the booking detail answers it read-only (all permissions false,
  no dead seats); `/me/bookings/upcoming|recent` and the admin member Bookings list it.
  *Why:* the member whose wallet carried the charge read "Booking not found" (E7-5).
- **Reports:** `penalty_count` counts bookings whose penalty rows net to a debit (a returned
  penalty is none); `/reports/me/daily` carries every wallet-report bucket plus
  `net_movement_minutes`, so a day row adds up (J7-2).
- **Desk `package_free`** (J7-10, integrator decision): a fourth sell code, valid only on a
  R0.00 shelf price; rand optional and 0; AdminTopUp with ZarPaid 0; no-charge mail. A R0.00
  package may still be sold under a paid code.
- **Mail minutes are words** (court time, lights-on duration); a package named by its minutes
  is said once on the PayFast ledger line.
- **R8 (lane BE):** a no-show reversed by a late scan records the SCAN too — `ReverseNoShowAsync(…, scan:
  ReversalScan)` stamps the scanner's seat (`SeatArrival`, shared with activation) and writes
  `court.activated`; the device caller passes it (E8-1). Words for `member.groups_changed`,
  `member_code.enrolled` (E8-3). A desk top-up with no rand taken (AdminTopUp ZarPaid 0 /
  `package_free`) is "gave them … at no charge" on the Night and change record (E8-5).
- **Time on court is ONE rule on member screens** (E8-4): play.md §1 sessions (`AttendanceQuery` —
  booker or accepted partner, minutes as the row stands) for `/me/play` and `/reports/me/wallet|daily`.
  *Why:* the reports counted own bookings at sold length; a partner read 0 beside 57 on Profile.
  The admin Night's `minutes_on_court` stays box-measured, not shown to members.
- **The grid's daily limit is the POST's** (J8-1): `BookingRules.HeldOnDayAsync` counts accepted
  partner seats for both.
