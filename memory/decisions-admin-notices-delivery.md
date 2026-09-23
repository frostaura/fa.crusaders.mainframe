---
name: crusaders-mainframe-decisions-admin-notices-delivery
description: "How an admin notice is delivered: a leased claim, per-recipient progress, a cooldown counted from rows that reached somebody on both sides, pruning capped by retention_years, and a feed whose sent_at means sent."
type: decision
last_verified: 2026-09-23
---

# Live decisions — delivering the admin notice outbox (R23)

Who is told what, and why, is `decisions-admin-notices.md`; this is how a row gets there.

- **Claim = lease, not a held lock**: one `UPDATE … FOR UPDATE SKIP LOCKED` stamps `LockedUntil`
  (10 min) and counts the attempt; each send is recorded in `DeliveredToJson` before the next, so a
  retry mails only who missed it. Backoff 1m/5m/15m/1h/6h, then `Failed`. A row claimed past
  `MaxAttempts` (a pass that threw outside the send) is failed `attempts_exhausted`, not re-claimed
  for ever. Residual: a crash between SMTP accepting and the record duplicates ONE mail to ONE admin.
- **Cooldowns suppress the mail, never the feed row** (`State = Suppressed`). A sibling counts as
  mailed when `RecipientCount > 0`, whatever its state, on BOTH sides of the row (± the cooldown),
  and only while the row itself has reached nobody. *Why:* counting only `Sent` let every sibling
  through while a partly-failed notice retried (3 mails in one window, review 2026-09-23). Spikes
  reuse `device_alert_cooldown_minutes`; top-up failures 30 min per reason; overdrafts 15 min per
  actor+member — the last two are contract constants, **awaiting Dean's ruling** against the
  "every configurable number is a tenant setting" invariant.
- **Pruning**: finished rows past `admin_notification_retention_days`, capped by the club's
  `retention_years` (notices hold personal data); a `schedule.conflict` row is kept until
  horizon + 1 day, because it is the only dedupe for a clash that still stands.
- **Feed**: `delivery.sent_at` is null unless `state == "sent"`; `delivery.finished_at` is when the
  row stopped being pending. The column is still named `SentAt` (no migration was spent on it).
- **Subjects are one line** (`EmailChrome.SubjectLine`, in `Compose` and the SMTP transport): name
  rules check length only, and a CR/LF in a name made `MailMessage` refuse the whole message.
