---
name: crusaders-mainframe-decisions-topups
description: "Member PayFast top-ups: the R1000 cap is cumulative per member over Completed plus FRESH Pending; a cancel return and a one-hour expiry close abandoned checkouts, reopenable by a late COMPLETE."
type: decision
last_verified: 2026-09-30
---

# Live decisions — member top-ups and the per-member cap

Spec: `docs/specs/payments-payfast.md` ("A checkout PayFast never reports on"). Code:
`Endpoints/TopUpEndpoints{,.Abandoned}.cs`, `Workers/TopUpExpiryWorker.cs`. Tests:
`TopUpAbandonedTests`, `TopUpItnIdempotencyTests` (D2-B04/B05).

- **The cap stays cumulative-lifetime per member** (review round 4, M4-1). The spec names only
  `topup_max_zar_per_member` (blueprint A.3 "max R1000 for members") with no window, so no
  rolling window was invented. It counts `Completed` plus `Pending` created within the last hour.
  *Why:* PayFast sends NO ITN on a cancel or an abandoned page, so every abandoned checkout used up
  the member's cap for good — live in production.
- **Three closings, none can lose money:** the cancel return (`POST /credit/topup/{id}/cancel`,
  own row, idempotent, conditional update → `Cancelled`/`cancelled_at_return`, no mail); fresh-only
  counting (`PendingLifetime` = 60 min); and `TopUpExpiryWorker` (`Cancelled`/`expired`, no mail,
  on start + every 5 min). **Both closings are reopenable** — a signed COMPLETE later still
  credits and clears the reason. Only the gateway's own CANCELLED/FAILED/mismatch is terminal
  (D2-B04). *Why:* the cancel return is the browser's word; a COMPLETE means money moved.
- **The lifetime is a constant, not `tenant_settings`** — it is PayFast's checkout, not a club
  policy, and being wrong costs only the cap (a late payment still credits). Revisit if a club
  ever needs slow EFT: a longer lifetime, or a column marking a PENDING ITN as in flight.
- **One-off production fix = the worker's pass on start.** Idempotent, touches only rows still
  Pending past the hour, mails nobody (a year of abandoned checkouts must not be mailed), leaves
  each reopenable. Counting already ignores those rows, so the member is unblocked by the deploy
  itself; the sweep is housekeeping for the status page and the desk.
- **Registration takes the member's `PayerLock`** around the cap read and the row insert and
  releases it before the gateway call. *Why:* eight registrations sent together all fitted one
  remainder (red in `Registrations_sent_together_cannot_overrun_the_ceiling`).
- **Accepted gap:** a completion that raced a cancel return clears the reason by forcing
  `FailureReason` modified; no test can force that interleaving (the mutant survives), and the
  cost would be a stale `failure_code` beside `Completed`, which the screen ignores.
