---
name: crusaders-mainframe-decisions-backend-r13a
description: "Backend round 13 (lane BE13a): a relit reversal's extra off is said when the court is next free, webhook is_admin is the read role, given minutes are not sold, the Night names withdrawals and displacements."
type: decision
last_verified: 2026-10-05
---

# Live decisions — backend, review round 13 (lane BE13a)

- **A relit reversal's extra `booking.lights_off` is stamped when the court is next free** (E13-1,
  refines I12). `LightsCueWorker.NextFreeAsync` walks forward from the restored end: nobody holds
  the court → `occurred_at` = the restored end; a live booking (Booked/Completed/NoShow, the
  statuses the off sweep closes) holds it and is not cued off yet → NO extra off (its own off closes
  the court, later by arrival and by `occurred_at`); a holder already over and cued off → the stamp
  moves to its end, chained. Cancelled and AdminBlock rows hold nothing; `data.ends_at` stays the
  restored end. *Why:* a collided reversal's restored end is the survivor's start, and an off
  stamped at the tick arrived after the survivor's `lights_on` — the mirror read their paid session
  dark. Stamping at the restored end alone is not enough: an early scan by the survivor still sorts
  before it.
- **Open, not fixed:** the ORDINARY end-of-slot sweep has the same shape for back-to-back bookings
  when the next member scans before the previous slot ends — its off is stamped at the tick.
- **`minutes.*` `actor.is_admin` is the actor's `User.IsAdmin`, read** (E13-2;
  `LedgerService.HoldsAdminAsync`, one tenant-filtered read, never for `Guid.Empty`). An admin is an
  admin on their own wallet too. *Why:* "actor ≠ wallet owner" called a member paying for a
  friend's court at the box an administrator. `BookingService` still emits `booking.created` with
  `ActorIsAdmin: actorId != userId` (BE13b's file) — same inference, not changed here.
- **Given minutes are not sold** (J13-2). `/admin/reports/revenue`: `gross_topups_minutes`,
  `net_minutes` and `zar_per_minute_sold` count paid funding only; desk gifts (AdminTopUp with
  `ZarPaid` 0 — `package_free` or a R0.00 sale) are `given_minutes`, additive. Sold + given = every
  funding row's minutes, so it still reconciles with Transactions; rand unchanged.
- **`Webhooks:AllowPrivateNetworks` is true in `appsettings.Development.json` only** (E13-7). The
  base file keeps `false`, so the guard's own `IsDevelopment()` default was dead; Production,
  Staging and Testing stay guarded (`R13WebhookPrivateNetworkConfigTests` reads the shipped files).
- **The Night** (`TraceKinds`, `AdminMemberTraceAssembly`):
  - D13-1: every court-box refusal branch at no mapped court of an unnamed box says "the court box".
  - E13-8: `booking.displaced` → "The club cancelled this booking on Court 1 and refunded it —
    Olive's earlier booking there was checked in late" (cause = owner of `displaced_by_booking_id`;
    neutral when unknown). Any audit row with no stored court names its `booking_id`'s court.
  - E13-4: `players.withdrew` (BE13b's C13-4 row, actor = subject = partner) is `booking.withdrew`
    on the partner's night and `booking.partner_withdrew` on the organiser's — read through
    `details.organiser_user_id` (jsonb containment, a third OR in the audit read). A share RETURN on
    a Withdrawn seat written at/after `RespondedAt` (seat parsed from `share:{participant:N}:…`) says
    "… — they withdrew from the game" and names the partner as actor even when the stored actor is
    the system (pre-R13 rows): only the partner can withdraw their own seat.
- Tests: `R13LightsCueCollisionTests`, `R13LedgerActorRoleTests`, `LedgerActorTests`,
  `R13RevenueGivenMinutesTests`, `R13WebhookPrivateNetworkConfigTests`, `R13TraceWordsTests`,
  `R13NightWordsHttpTests` — each seen red first.
