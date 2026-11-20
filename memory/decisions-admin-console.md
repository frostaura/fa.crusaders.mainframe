---
name: crusaders-mainframe-decisions-admin-console
description: "Admin console rules from the go-live passes: no href at the API, exports built from the reads, Approve is armed, every write reads back, unsettled bookings have a page, Members counts only a whole read."
type: decision
last_verified: 2026-11-20
---

# Decisions — the admin console (go-live passes, 2026-11-13/14)

From `frontend-admin.json` (FA-1…13), `browser-admin.json` (BA-01…27) and pass 2's lane app-rest. Reply contracts:
[`decisions-admin-contracts.md`](decisions-admin-contracts.md); lost replies:
[`decisions-admin-lost-replies.md`](decisions-admin-lost-replies.md); layout: [`decisions-admin-layout.md`](decisions-admin-layout.md).

- **No `href` may point at the API** (FA-1, the fourth occurrence after the wallet CSV, door log and night): a link
  carries no token, so the API answers `400 tenant_unresolved`. Faults and the change record use `DownloadCsvButton`
  (`components/monitoring/parts.tsx:36`: fetch with the bearer token, save the blob, say a refusal beside the button);
  the bare-link component is deleted; `src/csv-links.test.ts` fails on any `href` to `/api/` or a `…CsvUrl(` builder.
- **Exports are built in the console** (FA-7, BA-08): Transactions reads every page the filters select (name search on
  top, cap 50 000, said), Reports exports its days and courts — in the API's `CsvCell` conventions, numbers as numbers
  (a defused `-30` cannot be summed). *Why not a server route:* the reads already exist and are tenant-scoped; XLSX/PDF
  were cut from `reporting.md`. **Members and no-shows CSVs are server-built, PII minimal** (pass 2): name, number,
  status, groups, joined, balance — never email / phone / photo / PIN / fingerprint, because a saved file leaves access
  control; audited as `members.exported` / `no_shows.exported` (no person's Night). The member's own wallet CSV (R15 E15-10):
  `created_at,type,amount_minutes,reason,counterparty,cause,done_by,given,zar_paid,court,booking_starts_at,related_booking_id`,
  no `external_reference` (it leaked the tenant id), admin `done_by` = "The club", cells through `CsvCell`, `\r\n` lines.
- **No admin write is direct — true since FA-11** (it found five): reject / suspend / reactivate read the member's status
  back like Approve; package Retire, door delete and fingerprint enrol/remove read their lists back.
- **Approve is an armed ConfirmButton** (BA-02): one click approved and the next row slid under the pointer, so two clicks
  0.7 s apart let in an unseen applicant. Focus then goes to the NEXT applicant's Approve (`focusAfter`).
- **`<main>` scroll resets per page** (BA-06, `lib/scrollPage`); the members split view and a hash keep their place. **The
  live/demo switch stays on the admin page** (BA-12), `/admin` for a page naming a record. **Member celebrations are quiet
  on `/admin`** (BA-24), held, not dropped. The record's balance patches the list row (BA-07,
  `MembersSplit.onMemberBalance`). Settings' index rail measures live positions against `<main>` (BA-18,
  `lib/settingsSpy`: the IntersectionObserver kept tops from its last change and lit the section above the open one).
- **Wording** (BA-15/22, FC-8): a court is "Bookable" / "Hidden from booking"; the restart fault explains `uptime_ms`; a
  door that stops reporting talks about doors; slice and grace say the box ignores them; the walk-up cap says it caps the
  time buttons. Demo alerts say "Would have emailed" (`delivery.reason` `demo_club` / `told_recently`).
- **`/admin/bookings` exists** — the `booking.unsettled` notice linked to a route with no page. Its "Never settled"
  filter is `GET /admin/bookings/unsettled`, the SAME query the sweep counts (`AdminUnsettledBookingsEndpoint.Query`),
  decided row by row with the desk's cancel. **Trap:** a past booking is "inside the penalty window", so a plain cancel
  posts the late-cancel penalty; the page says to waive it to give everything back.
- **The club cancels a booking from its page, started included** (R15 J15-2, `AdminCancelPanel`): the grid's
  `CancelSheet`, always on the admin route (reason required; the server quote says "nothing is refunded" once checked
  in), hidden beside the organiser's own Cancel and on any non-booked status. **The desk's cancel 409s are worded and
  prove the grid stale** (R17): `booking_not_open` → already cancelled; `not_cancellable {status}` → played / no-show / a
  hold (`CANCEL_REFUSAL_TEXT`, `cancelRefusal`; both in `STALE_GRID_CODES`). A returned penalty is "… penalty returned" on
  Transactions and in the desk's booking picker (`recentBookingsFrom(rows, label)`).
- **The Members chips count only a club read whole** (R19 L19-1, `countableRows`): `readAt` (stamped when the last page
  lands) or a first read still walking (said: "Counts cover those"); a walk that failed part way counts nothing. *Why:*
  page 1 counted as the club read "Pending 1" with the applications on the page that answered 503. Other paged admin
  reads already fail whole or are one reply.
- **Load-proof tests** (FA-13): vitest `testTimeout`/`hookTimeout` 20 s; relative-time assertions freeze `Date` only
  (`vi.useFakeTimers({ toFake: ["Date"] })`), never the page's timers.
- **Not done, with reasons:** HTTP/1.1 connection starvation (wants gateway HTTP/2), the paint-grid density, hidden H1s;
  BA-21 needs a design decision. **BA-17 (the rail names the page) is recorded both ways:** "not changed, by decision
  … recorded design" (old app-rest pass 2) and "waits on / needs a design decision" (old ironclad pass 2 and state). The
  sources disagreed before the reorganisation; nobody has ruled — open in [`questions.md`](questions.md). **FC-8's
  1.x-gate corner** (§1 byte-identical bodies; every door gets 2.0.0 at its cable flash) **is recorded both ways too:**
  "not changed, by decision" (old app-rest pass 2) and "the contract owner's" / "waits on a decision" (old state and
  ironclad pass 2) — open in the same file. FM-8's per-host shell needs gateway SSI; BM-9 (mixed wire case) needs
  every reader on both sides switched in one change; BD-9 (a booking code buying at `/extend` reopens threat-model #19;
  every shipped phone shows v1, which extends) was left by decision.
