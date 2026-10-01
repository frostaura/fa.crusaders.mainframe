# Reporting Specification

Both players and admins get a transactions + activity reporting view. Same engine, scoped differently.

## Player view
A player sees their own data:
- **Wallet** — current balance in minutes, open package checkouts, ledger view (paginated, filterable).
- **My bookings** — past + upcoming bookings, status, court, duration, cost.
- **Time on court** — total minutes / hours played in the selected period.
- **Minutes spent** — sum of `booking_charge` minus refunds in the selected period (i.e. net spend on play, excluding penalties — penalties are broken out separately).
- **Penalties incurred** — count and total minutes.

## Admin view
A tenant admin sees the above for any individual member, plus tenant-wide:
- **Revenue** — sum of `top_up` net of `payment_reversal` in the period. Money the tenant actually took, in rand, beside the minutes it sold for it and the rate between them (below).
- **Bookings issued** — count, broken down by court / weekday / hour-of-day.
- **Court utilisation** — % of available slices booked, per court, per day. Heatmap chart (court × hour).
- **No-show rate** — count and % of bookings that no-showed; trend line over time.
- **Penalty income** — total minutes kept via penalties.
- **Member activity** — most active members, dormant members (no booking in 30 days), low-balance members.
- **Peripheral health** — uptime per court, failed-read rate, average match latency.

## Filters
Every report supports:
- **Time range** — quick presets (Today, Yesterday, Last 7 days, Last 30 days, This month, Last month, This year, Custom range).
- **Court(s)** — multi-select.
- **Member(s)** — multi-select with type-ahead (admin only).
- **Event type(s)** — multi-select (e.g. `booking.created`, `minutes.purchased`).
- **Status** — booked / cancelled / no-show / completed.

Filter state lives in the URL query string so a report can be shared / bookmarked.

### The report window — what `from` and `to` mean

Every endpoint that takes a time range takes it as `from` and `to`, and **both are day
markers, not instants**: what is read off each parameter is the UTC calendar date it names,
and nothing else about it. The report then covers every one of the **club's own** calendar
days from `from`'s date to `to`'s date, **inclusive at both ends** — the window handed to the
queries is the one UTC interval that holds exactly those days, in `tenant_settings.timezone`.

Three consequences a caller has to know:

- **The day `to` names is covered in full.** `to=2026-03-06T00:00:00Z` reads as an *exclusive*
  midnight if you take it for an instant, and it is not one: the whole of 6 March is in the
  report. So `…T00:00:00Z` and `…T23:59:59Z` on the same date name the same window, and there
  is no shape of `to` that asks for part of a day. The Reports page sends the second of those
  (`Reports.tsx`), so this clause is about **direct API callers** — but it is the reading the
  page's own shape already depended on, and stating only one of the two would leave the other
  free to drift.
- **The club's clock decides the edges, not UTC's.** A movement at 00:30 on the first day is
  in the report for a club at UTC+2, where the window opens at 22:00Z the evening before. The
  markers themselves are read in UTC precisely so that they name the same two dates whether
  the club is east or west of UTC.
- **Omitting a parameter is not the same as passing today's date.** With no `to` the last day
  is the club's *current* day, which runs to the end of the club's day — up to 24 hours ahead
  of now. Nothing in the app calls these endpoints without a range; a caller that does gets a
  window that includes bookings which have not happened yet.

Endpoints on this contract: `/api/v1/reports/me/wallet`, `/reports/me/wallet.csv`,
`/reports/me/daily`, `/api/v1/admin/reports/revenue`, `/utilisation`, `/no-shows` and
`/daily`. They share one helper (`ReportingEndpoints.ResolveWindow`) and are pinned together
by `ReportWindowTests`, one test per endpoint, because a combined test can only fail on its
first assertion and would hide four unpinned surfaces behind one.

## Units — minutes and rand (P13)

The unit of account is **whole minutes** (`minutes-and-packages.md`). Every report figure about court
time or a balance is an integer number of minutes under a `*_minutes` key; rand appears only where a
member actually paid rand, under a `*_zar` key. The two are never converted into each other.

| Route | Keys |
| --- | --- |
| `GET /api/v1/admin/reports/revenue` | `gross_topups_zar`, `reversals_zar`, `net_zar` (rand); `gross_topups_minutes`, `reversals_minutes`, `net_minutes`; `zar_per_minute_sold` = `net_zar ÷ net_minutes` rounded **down** to 4 decimals, `null` when `net_minutes ≤ 0` |
| `GET /api/v1/admin/reports/utilisation` | per court `booked_minutes`, `blocked_minutes`, `sold_minutes` (Σ `AmountChargedMinutes`, what the bookings were charged) and `kept_minutes` (what the ledger says the club kept — charged, less refunds, net of penalties kept) |
| `GET /api/v1/admin/reports/daily`, `/reports/me/daily` | every movement bucket as `*_minutes` |
| `GET /api/v1/reports/me/wallet`, `GET /api/v1/admin/members/{id}/spend` | `top_ups_minutes`, `spent_minutes`, `refunds_minutes`, `penalties_minutes`, `adjustments_minutes`, `reversals_minutes`, `share_transfers_minutes`, `net_court_spend_minutes`, `net_movement_minutes`; `minutes_on_court` is play time, not money |

CSV money columns are **raw integers with no unit suffix** — `45`, never `45.00`:
`/reports/me/wallet.csv` is `created_at,type,amount_minutes,reason,external_reference,related_booking_id`;
`/admin/members/{id}/trace.csv` ends `…,court,amount_minutes,balance_after_minutes,source`.

The admin ledger's `totals` are `{count, in_minutes, out_minutes, net_minutes}` — minutes in, minutes
out (a magnitude) and their difference over the filtered range.

## Charts
- **Time series:** line chart, one series per dimension. Default view: bookings per day for the last 30 days.
- **Distribution:** bar chart for "by court", "by weekday", "by hour-of-day".
- **Heatmap:** day-of-week × hour-of-day, cell intensity = booking count. Used for "when is the club busy".
- **KPI cards:** big-number callouts at the top of each report (total revenue in rand, minutes sold, rand per minute sold, total bookings, total court hours, no-show %).

Charts render with Recharts. See `design-system.md` § Charts for color rotation and styling rules.

## Exports
Every report has an "Export" button with format options:
- **CSV** — flat table, one row per ledger entry / booking.
- **XLSX** — same data, with column types preserved and a header row formatted in bold.
- **PDF** — formatted report including the charts (Puppeteer-rendered backend job).

Export respects the active filters. Filename pattern: `crusaders-mainframe_<tenant-slug>_<report-name>_<from>-<to>.<ext>`.

Exports run as a backend job; for >10k rows the user gets an email with a download link rather than a synchronous download. Generated files are kept for 7 days, then deleted.

## The door log is not a report

`GET /api/v1/admin/doors/activity` and its `.csv` (`door-gate.md` §13) look like a report and
are deliberately not one, and the differences are rules rather than omissions.

- **It is never a reporting DIMENSION.** Nothing here may gain a per-member door filter, a
  door-scan bucket, a "who comes in most" chart or a door column on a member's ledger view.
  `door-gate.md` §1 and the P3 rule are explicit: a door scan is never attendance, the admin
  log filters by door, time and outcome only, and a member's door history belongs to the
  member (`GET /api/v1/me/door/history`). An entry aggregated by person is the attendance
  report this product refuses to build.
- **Its export is synchronous and hard-capped at 10 000 rows**, not queued with an emailed
  link past 10k. A door log is read at a desk, while somebody is standing there asking what
  happened last night; a link arriving by email an hour later answers nobody. Rows past the
  cap are dropped and the response says so in `X-Crusaders-Truncated`.
- **CSV only** — no XLSX, no PDF. There is no chart to render and no formatting to preserve.
- **Its filename is `door-log-<from>-<to>.csv`**, not the report pattern above. It is not
  scoped by tenant in the name because it is downloaded by an admin already inside one club.
- **Nothing is kept for seven days.** The file is built in memory and handed over; there is no
  generated artefact on disk to expire, which is the right posture for a file whose rows a club
  has asked to be deleted after `door_log_retention_days`.
- **The export IS audited**, as a member-ledger view is: one `doors.log_exported` row naming
  the actor, the filters and the row count — and, unlike the ledger row above, **no subject**,
  because an export is about a range of rows rather than about a person.

What it does share with everything here: **the club's timezone**. The doors page's day
boundary comes from `tenant_settings.timezone` on the server, for the reason this document
already gives — stored timestamps are UTC and only the server knows which day a club keeps.

## Implementation notes
- **No client-side aggregation over large datasets.** Server returns pre-aggregated buckets keyed by the filter dimensions. The frontend consumes ready-to-render data.
- **Caching:** common reports (today, last 7 days) are cached server-side for 60s per tenant. Player views are not cached (they're cheap and small).
- **Time zone:** all reports honor the tenant's `tenant_settings.timezone` (default `Africa/Johannesburg`). Stored timestamps are UTC.
- **Audit access:** admin views of an individual member's ledger are logged in `tenant_audit` with `{actor, subject, action: "viewed_member_ledger"}`. Members can request to see who has viewed theirs.
