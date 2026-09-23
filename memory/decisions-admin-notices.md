---
name: crusaders-mainframe-decisions-admin-notices
description: "Every admin mail goes through one outbox staged in the event's own save, to active confirmed admins minus the actor and opt-outs; three kinds are non-optional, and tests must drive the outbox themselves."
type: decision
last_verified: 2026-09-23
---

# Live decisions — how the club's administrators are told things (R23)

The catalogue is `Services/AdminEventCatalogue.cs`; the user-facing summary is
`docs/specs/feature-spec.md` §11 "Admin notices".

- **One outbox, `admin_notifications`, staged in the event's own save** (`AdminNotices.Stage`,
  which never saves). *Why:* every admin mail used to fire after the commit, so a crash in
  between lost it and a retried path doubled it. The unique `(TenantId, DedupeKey)` index, keyed on
  the event's own identity (user id, outage id, booking id), is what makes a re-run a no-op.
  **Observations** — a schedule clash, a spike, the daily reminder, an unsigned ITN — have no write
  to ride on and use `AdminNotices.RaiseAsync` (own save, collision = "already raised"). A clash
  must never ride on the horizon's save: it re-collides every sweep and would fail that save.
- **Recipients are resolved at delivery**: `IsAdmin && Status == "active" && EmailVerified`, minus
  the row's actor, minus opt-outs for optional kinds; a kind that notifies its subject (only
  `admin.role_changed`) mails the subject their own message instead. *Why unverified is excluded:*
  some notices carry names and balances, and nothing proves the address reaches the person.
- **Non-optional kinds: `admin.role_changed`, `webhook.auto_disabled`, `code.forgery_suspected`.**
  `PUT /me/preferences` refuses them (`notification_kind_not_optional`); delivery ignores a stored
  one anyway. Webhook is on the list because it is the one mail the webhook spec promises the owner.
- **Claim = lease, not a held lock**: one `UPDATE … FOR UPDATE SKIP LOCKED` stamps `LockedUntil`
  (10 min) and counts the attempt; each successful send is recorded in `DeliveredToJson` before the
  next, so a retry mails only who missed it. Backoff 1m/5m/15m/1h/6h, then `Failed` + LogError.
  Residual: a crash between SMTP accepting and the record duplicates ONE message to ONE admin.
- **Cooldowns suppress the mail, never the feed row** (`State = Suppressed`). Spikes reuse
  `device_alert_cooldown_minutes`; top-up failures 30 min per reason; overdrafts 15 min per
  actor+member — the last two are contract constants (they bound one admin's own action), not
  club settings. Outage mails keep their existing derived announcement; the outbox adds no cooldown.
- **Top-up: only what the club can act on** — amount mismatch, gateway error, provider register
  failed, unsigned ITN (one per club per hour: the route is anonymous), missing payment id. Declines
  and cancellations mail the member only.
- **Webhook disable reaches admins for CLUB endpoints only**; a member endpoint's owner mail is still
  owed. The destination is scheme+host, never path or query (template variables live there).
- **Four new settings**: `fault_spike_count` (5, 2–100), `fault_spike_minutes` (15, 5–240),
  `application_reminder_hours` (24, 1–168), `admin_notification_retention_days` (90, 7–730) —
  snake_case only on the PUT, always present on the GET.

## The trap this leaves for tests

- **No test host runs hosted services, so admin mail arrives only when a test delivers it**:
  `TestHost.DeliverAdminNoticesAsync(now)` / `PeopleClub.DeliverAdminNoticesAsync(app)`. A test that
  ticks a worker at a future instant must deliver at THAT instant or the row is not yet due
  (`PeripheralHealthTests.SweepThenDeliver`).
- **The Postgres tier shares one database, and a delivery pass claims every club's due rows** — so
  another class's pending notices land in your mail stub. Scope every mail count to your club.
