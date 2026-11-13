---
name: crusaders-mainframe-decisions-admin-golive-pass
description: "The admin console's pre-go-live fixes (2026-11-13): armed Approve, token-fetched CSVs and the href guard, console-built exports, no direct writes, scroll reset, demo switch, load-proof tests."
type: decision
last_verified: 2026-11-13
---

# Decisions — the admin console's go-live pass (lane frontend-admin, 2026-11-13)

From `frontend-admin.json` (FA-1…FA-13) and `browser-admin.json` (BA-01…BA-27).

- **No `href` may point at the API** (FA-1, the fourth occurrence after the wallet CSV, door log
  and night): a link carries no token, so the API answers `400 tenant_unresolved`. Faults and the
  change record use `DownloadCsvButton` (fetch with the bearer token, save the blob, say a refusal
  beside the button); the bare-link component is deleted; `src/csv-links.test.ts` fails on any
  `href` to `/api/` or a `…CsvUrl(` builder.
- **Exports are built in the console** (FA-7, BA-08): Transactions reads every page the filters
  select (name search on top, cap 50 000, said), Reports exports its days and courts — in the
  API's `CsvCell` conventions, numbers as numbers (a defused `-30` cannot be summed). *Why not a
  server route:* the reads already exist and are tenant-scoped; XLSX/PDF were cut from
  `reporting.md`. Members and no-show CSVs are not built.
- **No admin write is direct — now true** (FA-11 found five that were): reject/suspend/reactivate
  read the member's status back like Approve; package Retire, door delete and fingerprint
  enrol/remove read their lists back. The R4 sentence in `decisions-admin-lost-replies` was false
  until this pass.
- **Approve is an armed ConfirmButton** (BA-02): one click approved and the next row slid under the
  pointer, so two clicks 0.7 s apart let in an unseen applicant. Focus then goes to the NEXT
  applicant's Approve (`focusAfter`), never the leaving row's.
- **`<main>` scroll resets per page** (BA-06, `lib/scrollPage`); the members split view and a hash
  keep their place. **The live/demo switch stays on the admin page** (BA-12), `/admin` for a page
  naming a record. **Member celebrations are quiet on `/admin`** (BA-24), held, not dropped.
- **The record's balance patches the list row** (BA-07) through `MembersSplit.onMemberBalance`.
- **Settings' index rail measures live positions against `<main>`** (BA-18, `lib/settingsSpy`): the
  IntersectionObserver kept tops from its last change and lit the section above the open one.
- **Wording**: a court is "Bookable" / "Hidden from booking" (BA-15); the restart fault explains
  `uptime_ms` (BA-22); a door that stops reporting talks about doors; slice and grace say the box
  ignores them, the walk-up cap says it caps the time buttons (FC-8).
- **Load-proof tests** (FA-13): vitest `testTimeout`/`hookTimeout` 20 s; relative-time assertions
  freeze `Date` only (`vi.useFakeTimers({ toFake: ["Date"] })`), never the page's timers.

Not done here, with the reason in the lane report: Overview's "needs attention" for lights
mismatches (server-side anomaly), the photo requirement on register (backend), HTTP/1.1
connection starvation (gateway HTTP/2), the paint-grid density, Night-picker width, hidden H1s.
