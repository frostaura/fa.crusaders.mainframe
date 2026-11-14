---
name: crusaders-mainframe-decisions-app-rest-pass2
description: "Ironclad pass 2, lane app-rest (2026-11-14): refund desk, unsettled list, BA-04 server faults, member and no-show CSVs, settings spelling, demo alerts, automatic code moves said, FM-7/12."
type: decision
last_verified: 2026-11-14
---

# Decisions — pass 2, lane app-rest (branch `fix/app-rest`, over `fix/ironclad`)

- **Refund or chargeback is a desk sheet on the member's ⋯** (BM-6): purchase → amounts → check,
  rand and minutes asked apart, capped at what `/reversible` says is left. **Lost reply = re-read
  the purchase** (grew by this press → landed; read and not grown → absent, key kept; unreadable →
  unknown). *Why the purchase, not the ledger:* the reversal names its funding row, so "what has gone
  back on it" is the exact question. Offered to any member with a membership: a suspended member's
  refund still nets revenue. **BA-20:** Adjust, Sell and Refund share `DeskConfirmFooter`.
- **`/admin/bookings` exists** — the `booking.unsettled` notice linked to a route with no page. Its
  "Never settled" filter is `GET /admin/bookings/unsettled`, the SAME query the sweep counts
  (`AdminUnsettledBookingsEndpoint.Query`), decided row by row with the desk's cancel. **Trap:** a
  past booking is "inside the penalty window", so a plain cancel posts the late-cancel penalty; the
  page says to waive it to give everything back.
- **Lights on with nothing booked / checked in on a dark court are server faults** (BA-04),
  `lights_on_nothing_booked` (warning) and `checked_in_lights_off` (error), filed by the admin sweep
  by the tile's own rule and resolved by it ("Cleared on its own"). *Why faults:* Faults, the
  Overview's Needs attention and the spike mail then need nothing new.
- **Members and no-shows CSVs are server-built, PII minimal** (BA-08): name, number, status, groups,
  joined, balance; never email/phone/photo/PIN/fingerprint. *Why:* a saved file leaves access
  control. Audited as `members.exported` / `no_shows.exported` (no person's Night).
- **A snake-only settings key is heard camelCase** (`SettingsSpelling`, by reflection); two
  spellings that disagree are `400 setting_spelled_twice`. *Why not refuse camelCase:* the console
  sends both spellings for box keys.
- **Demo alerts say "Would have emailed"** (BA-12): the feed carries `delivery.reason`
  (`demo_club` / `told_recently`); seeded demo notices are suppressed, never "sent".
- **An automatic member-code move raises `member_code.phase_moved`** (MCV1-09), once per move;
  the legacy phase's console words no longer claim phones show the old code (MCV1-04).
- **The widest v3 vector writes `device_fault_max_per_hour` 120**, 4086 bytes (the C++ test binds
  only fit and parse); the court box's buffer comments were corrected to 4086 at integration.
- **FM-12:** `vite.config.ts` stops every gate over a stale install (`src/depsFreshness.ts`).
- **FM-7, measured:** 1,492 act warnings → fixed chart-theme (813, unmount the animating chart),
  AdminDoorsLog, AdminLedger and nine more (`vi.waitFor` never leaves act; RTL `waitFor` does),
  `settledIt` for files whose providers land after the last line. Node webstorage and jsdom canvas
  noise are gone. **Not zero:** Inbox, BookSheet.players, AdminDoors, admin-members-notification
  and ~25 small files update mid-test and need per-test awaits; a hard fail-on-warning gate would
  be flaky while they remain.
- **Not changed, by decision:** BD-9 (a booking code buying at `/extend` reopens threat-model #19;
  every shipped phone shows v1, which extends); FC-8's 1.x-gate corner (§1 byte-identical bodies;
  every door gets 2.0.0 at the last flash); BA-17 (the rail names the page, recorded design);
  BM-9 (needs every reader on both sides switched in one change).
