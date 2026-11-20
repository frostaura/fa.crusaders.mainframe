---
name: technologies-crusaders-squash-control-system-decisions-email-outbox
description: "How mail leaves: IEmailService only queues (SKIP LOCKED sender, backoff, email.undeliverable on a final failure), the admin notice dispatcher sends direct, held member mail is re-derived at the send, coalesced, released in order."
type: decision
last_verified: 2026-11-20
---

# Live decisions — how mail leaves the building

The rule itself is a CLAUDE.md invariant ("Email never holds a request"); this is how it is built and why.

## The email outbox (2026-10-07)
Approving a member awaited the welcome mail's SMTP round trip in the request: measured 15,346 ms against a mail host
that accepts and never answers (the transport's 15 s timeout), 89 ms after.

- **`IEmailService` queues; `IEmailTransport` sends.** `IEmailService` is `EmailOutboxService` (a singleton, one small
  insert in its own scope, `Program.cs:439`); `IEmailTransport` is `DemoAwareEmailService` over `SmtpEmailService`
  (`:436`), resolved only by the two senders — `EmailOutboxDispatcher` and `AdminNotificationDispatcher`. A returned
  `SendAsync` means *queued*, never delivered. `EmailDispatch.QueueAsync` is the never-throws wrapper for post-commit
  paths; the `Task.Run` send copies (`EmailDispatch.InBackground`, `BookingService.SendEmailInBackground`) are gone.
- **Demo suppression runs BEFORE storing** (ambient demo flag or a `.invalid` address): no demo mail is ever a row.
- **The table is system-wide, not tenant-filtered**, with a nullable `TenantId` from `AmbientTenant` (raised by
  `TenantContext.Set`) so a final failure can tell the right club.
- **Sender**: `EmailOutboxDispatcher` claims `FOR UPDATE SKIP LOCKED` (lease 5 min, counted attempts), four sends at
  once, backoff 30 s / 2 m / 10 m / 1 h / 6 h then `Failed`; woken by `EmailOutboxSignal` on enqueue, polls every 5 s.
  A sent row drops its body and attachments.
- **A final failure is announced**: an `email.undeliverable` admin notice (cooldown scope `smtp`), mailed by
  `AdminNotificationDispatcher` straight over the transport. *Why direct:* that table is already an outbox with its own
  retries; queueing again would hide a failure from the loop that owns it.
- **Wire fields say what is true**: `member_notified` → `member_email_queued`, `email_sent_to` → `email_queued_to`,
  `TransitionReport.MemberNotified` → `EmailQueued`.
- **Retention**: `EmailOutboxRetention` (nightly `RetentionWorker`) drops sent rows after 7 days, failed after 30.
- **Residual**: the booking confirmation still composes (reads + receipt PDF) in a `Task.Run` before it queues
  (`BookingService.cs:579`), a perf-round choice ([`decisions-perf.md`](decisions-perf.md)); a crash in that window
  loses the mail. Everything else is durable.
- **Deploy**: migration `AddEmailOutbox` is additive (create table and indexes only), no manual step; mail in flight at the restart that shipped it was not recoverable.

## Held member mail, judged when it leaves (review round 2, C8)
Code `Services/Players/MemberMailRelease.cs`, on `AdminNotificationDispatcher`'s member path (member mail rides the
admin notice outbox with `Audience`/`RecipientUserId`). Tests `R2MailReleaseHttpTests`. Spec `players-and-splits.md`
§6, `play.md` §8.

- **Judged at the SEND, not the staging**, for every non-urgent member mail, whatever held it (quiet hours or a
  backoff). *Why:* quiet hours froze 23:00's payload until 07:00, and members got a confirm link for a withdrawn 3–0,
  an invite to a game cancelled overnight and "share now 16" beside the 0 that replaced it.
- **Dropped when obsolete** (invite not open, game off, seat gone, result not pending or not the reader's, reminder's
  share paid, return posted, removal undone by a re-add): `Suppressed`, `LastError = "dropped: <reason>"`, and its
  dedupe key is freed (`x:{id}:` prefix) — else a withdrawn ask that never left would "use up" the booking and a fresh
  result would never be asked about (`play.result_to_confirm` mails once per booking and member, by key).
- **Re-rendered otherwise** from today's booking, seat and result (court, start, share, score, deadline); payloads
  carry `seat_id` since C8, older rows fall back to the path or the reader's latest seat on the booking.
- **Coalesced per (member, booking, kind)** for invite, club seat, reminder, share changed and result to confirm: a
  later pending OR sent row of the same key supersedes. **Deliberate deviation from the contract's letter:** lapse and
  return-waiting never coalesce — each names one partner, and an organiser with two partners' returns waiting must hear
  both. Urgent receipts (share moved, game cancelled) are never re-derived.
- **Released in the order it happened** (`DueAt, CreatedAt, Id`, re-imposed in C# after `RETURNING`, which promises no
  order). *Why:* quiet hours make a night's mail fall due at one instant, and id order released it at random — a mutant
  ordering by id alone fails the five-invite test.
- **A cancellation never follows the invite it supersedes**: the held invite drops (`game_off`), and an UNANSWERED
  invitee is not mailed the cancellation at all (R4 M4-5, inbox line only — `ShareSweep.TellCancelledAsync`). *Why:* the
  kind is urgent, so a game cancelled at 23:00 mailed a stranger to it at once while their invite was held. Accepted
  partners are still mailed at once.
