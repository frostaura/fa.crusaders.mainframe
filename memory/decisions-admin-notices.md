---
name: crusaders-mainframe-decisions-admin-notices
description: "Every admin mail goes through one outbox staged in the event's own save, to active confirmed admins minus the actor and opt-outs; three kinds are non-optional, and tests must drive the outbox themselves."
type: decision
last_verified: 2026-09-23
---

# Live decisions — how the club's administrators are told things (R23)

The catalogue is `Services/AdminEventCatalogue.cs`; the user-facing summary is
`docs/specs/feature-spec.md` §11 "Admin notices". How a row is delivered, cooled down, pruned and
shown on the feed: `decisions-admin-notices-delivery.md`.

- **One outbox, `admin_notifications`, staged in the event's own save** (`AdminNotices.Stage`,
  which never saves). *Why:* every admin mail used to fire after the commit, so a crash in
  between lost it and a retried path doubled it. The unique `(TenantId, DedupeKey)` index, keyed on
  the event's own identity (user id, outage id, booking id), makes a re-run a no-op.
  **Observations** — a clash, a spike, the daily reminder, an unsigned ITN — use
  `AdminNotices.RaiseAsync` (own save, collision = "already raised"); a clash must never ride on
  the horizon's save, which it would re-collide with every sweep.
- **Recipients are resolved at delivery**: `IsAdmin && User.Status == "active" && EmailVerified`,
  minus the actor, minus opt-outs for optional kinds; `admin.role_changed` mails its subject their
  own message. Unverified is excluded because notices carry names and balances. **A suspended
  MEMBERSHIP does not stop admin mail** — admins bypass membership suspension at login and the
  last-admin guard counts `User.Status` only; one definition of "active admin" beats two.
- **Non-optional kinds: `admin.role_changed`, `webhook.auto_disabled`, `code.forgery_suspected`.**
  The PUT refuses them (`notification_kind_not_optional`), delivery ignores a stored one, and
  **the GET filters a stored one out** — a screen saving back what it read must not be refused.
- **A fault spike counts faults that OPENED in the window** (`FirstSeenAt`), never `LastSeenAt`:
  five old faults still repeating were a "spike" in every window, ~20 mails a day.
- **Top-up: only what the club can act on** — amount mismatch, gateway error, provider register
  failed, missing payment id, unsigned ITN (**one per club per UTC day**: the route is anonymous,
  and hourly let anyone mail every admin 24× a day). The admin mail's closing line is per reason:
  a missing payment id is a member who HAS PAID, is still `Pending` and has not been told.
- **Webhook disable reaches admins for CLUB endpoints only**; the destination is scheme+host.
- **Settings**: `fault_spike_count` (5, 2–100), `fault_spike_minutes` (15, 5–240),
  `application_reminder_hours` (24, 1–168), `admin_notification_retention_days` (90, 7–730).

## Owed

- The Tester 001 production-log check and the From/mailbox mismatch; the member-owned webhook
  owner's mail; control characters refused in full names at registration; a lease sized for more
  than one API instance (worst-case pass ≈ 25 min > the 10-min lease).

## The trap this leaves for tests

- **No test host runs hosted services**: deliver with `TestHost.DeliverAdminNoticesAsync(now)` /
  `PeopleClub.DeliverAdminNoticesAsync(app)`, at the instant a ticked worker used.
- **The Postgres tier shares one database and a pass claims every club's due rows** — scope every
  mail count to your club, and loop the pass until YOUR rows leave `Pending`.
