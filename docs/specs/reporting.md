# Reporting Specification

Both players and admins get a transactions + activity reporting view. Same engine, scoped differently.

## Player view
A player sees their own data:
- **Wallet** — current balance, pending top-ups, ledger view (paginated, filterable).
- **My bookings** — past + upcoming bookings, status, court, duration, cost.
- **Time on court** — total minutes / hours played in the selected period.
- **Money spent** — sum of `booking_charge` minus refunds in the selected period (i.e. net spend on play, excluding penalties — penalties are broken out separately).
- **Penalties incurred** — count and total ZAR.

## Admin view
A tenant admin sees the above for any individual member, plus tenant-wide:
- **Revenue** — sum of `top_up` net of `payment_reversal` in the period. Money the tenant actually took.
- **Bookings issued** — count, broken down by court / weekday / hour-of-day.
- **Court utilisation** — % of available slices booked, per court, per day. Heatmap chart (court × hour).
- **No-show rate** — count and % of bookings that no-showed; trend line over time.
- **Penalty income** — total ZAR collected via penalties.
- **Member activity** — most active members, dormant members (no booking in 30 days), low-balance members.
- **Peripheral health** — uptime per court, failed-read rate, average match latency.

## Filters
Every report supports:
- **Time range** — quick presets (Today, Yesterday, Last 7 days, Last 30 days, This month, Last month, This year, Custom range).
- **Court(s)** — multi-select.
- **Member(s)** — multi-select with type-ahead (admin only).
- **Event type(s)** — multi-select (e.g. `booking.created`, `credit.topped_up`).
- **Status** — booked / cancelled / no-show / completed.

Filter state lives in the URL query string so a report can be shared / bookmarked.

## Charts
- **Time series:** line chart, one series per dimension. Default view: bookings per day for the last 30 days.
- **Distribution:** bar chart for "by court", "by weekday", "by hour-of-day".
- **Heatmap:** day-of-week × hour-of-day, cell intensity = booking count. Used for "when is the club busy".
- **KPI cards:** big-number callouts at the top of each report (total revenue, total bookings, total court hours, no-show %).

Charts render with Recharts. See `design-system.md` § Charts for color rotation and styling rules.

## Exports
Every report has an "Export" button with format options:
- **CSV** — flat table, one row per ledger entry / booking.
- **XLSX** — same data, with column types preserved and a header row formatted in bold.
- **PDF** — formatted report including the charts (Puppeteer-rendered backend job).

Export respects the active filters. Filename pattern: `crusaders-mainframe_<tenant-slug>_<report-name>_<from>-<to>.<ext>`.

Exports run as a backend job; for >10k rows the user gets an email with a download link rather than a synchronous download. Generated files are kept for 7 days, then deleted.

## Implementation notes
- **No client-side aggregation over large datasets.** Server returns pre-aggregated buckets keyed by the filter dimensions. The frontend consumes ready-to-render data.
- **Caching:** common reports (today, last 7 days) are cached server-side for 60s per tenant. Player views are not cached (they're cheap and small).
- **Time zone:** all reports honor the tenant's `tenant_settings.timezone` (default `Africa/Johannesburg`). Stored timestamps are UTC.
- **Audit access:** admin views of an individual member's ledger are logged in `tenant_audit` with `{actor, subject, action: "viewed_member_ledger"}`. Members can request to see who has viewed theirs.
