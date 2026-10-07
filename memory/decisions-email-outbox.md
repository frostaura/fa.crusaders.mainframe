---
name: crusaders-mainframe-decisions-email-outbox
description: "Email never holds a request: IEmailService queues into the email_outbox table, a SKIP LOCKED worker sends over SMTP with backoff, a final failure raises an email.undeliverable admin notice, and the admin notice dispatcher keeps its own direct SMTP."
type: decision
last_verified: 2026-10-07
---

# Live decisions — the email outbox (2026-10-07)

Approving a member awaited the welcome mail's SMTP round trip in the request: measured 15,346 ms
against a mail host that accepts and never answers (the transport's own 15 s timeout), 89 ms after.

- **`IEmailService` queues; `IEmailTransport` sends.** The application's `IEmailService` is
  `EmailOutboxService` (a singleton, one small insert in its own scope); SMTP is `IEmailTransport`
  (`SmtpEmailService`, wrapped by the demo guard). A returned `SendAsync` means *queued*, never
  delivered. `EmailDispatch.QueueAsync` is the never-throws wrapper for post-commit paths; the
  `Task.Run` copies (`EmailDispatch.InBackground`, `BookingService.SendEmailInBackground`) are gone.
- **Demo suppression runs BEFORE storing** (ambient demo flag or a `.invalid` address): no demo mail is ever a row.
- **The table is system-wide, not tenant-filtered**, with a nullable `TenantId` taken from
  `AmbientTenant` (raised by `TenantContext.Set`) so a final failure can tell the right club.
- **Sender**: `EmailOutboxDispatcher` claims with `FOR UPDATE SKIP LOCKED` (lease 5 min, counted
  attempts), four sends at once, backoff 30 s / 2 m / 10 m / 1 h / 6 h then `Failed`. Woken by
  `EmailOutboxSignal` on enqueue, polls every 5 s. A sent row drops its body and attachments.
- **A final failure is announced**: an `email.undeliverable` admin notice (cooldown scope `smtp`,
  the spike cooldown), mailed by `AdminNotificationDispatcher` straight over the transport.
  *Why direct:* that table is already an outbox with its own retries; queueing it again would hide a
  failure from the one loop that owns it.
- **Wire fields renamed to say what is true**: `member_notified` -> `member_email_queued`,
  `email_sent_to` -> `email_queued_to`, `TransitionReport.MemberNotified` -> `EmailQueued`.
- **Retention**: `EmailOutboxRetention` (in the nightly `RetentionWorker`) drops sent rows after 7 days, failed after 30.
- **Residual**: the booking confirmation still composes (reads + receipt PDF) in a `Task.Run` before
  it queues, a perf-round choice; a crash in that window loses the mail. Everything else is durable.
- **Deploy**: migration `AddEmailOutbox` is additive; no manual step. In-flight mail at the moment
  of the restart (old process) is the old fire-and-forget window and is not recoverable.
