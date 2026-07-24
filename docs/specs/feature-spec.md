# Feature Specification — Crusaders Mainframe

This is the canonical functional spec. Engineering implements this; deviations require a spec update first.

## 1. Roles & member classes
- **Player** — end-user, member of a tenant (club). Books, plays, pays, cancels.
- **Admin** — tenant-scoped operator. Can do anything a player can plus all admin operations within their tenant.
- **Platform admin** — cross-tenant operator (Dean by default). Can onboard new tenants and act as any tenant admin. *Implementation note: this is the same `User` entity with a `is_platform_admin` flag, scoped above `tenant_id`.*

**Member class** — every active membership has a class that drives pricing and access (per [client blueprint](./client-blueprints/Crusaders-Blueprint-2026-05-Rev2.md) A.7):
- `Regular` — standard member.
- `LeagueOrSenior` — league players and members aged 65+. More credits per rand on top-up (A.8) and exclusive access to peak-hour slots until close to slot start (A.12).

Class is admin-assignable and editable, audit-logged on every change.

## 2. Registration & identity verification
1. Player visits the tenant's mobile web app and selects "Register".
2. Required fields, all mandatory:
   - Full name
   - Email address
   - Membership number (tenant-issued)
   - Photo upload (selfie, square, used as identification on the booking grid)
3. On submit:
   - Account created in `pending_approval` status.
   - Email verification link sent (24h expiry).
   - Player sees "We've emailed you to confirm your address. After confirmation, an admin will review and approve your membership."
   - All tenant admins notified (email + in-app).
4. Admin reviews in their console:
   - **Approve:** account becomes `active`. Welcome email goes out with a one-time magic-link sign-in (short-lived JWT in querystring, single-use, ≤15 min expiry). Webhook event fires.
   - **Reject:** admin must enter a reason (free text). Account becomes `rejected`. Rejection email sent with the reason. Webhook event fires.
5. Once `active`, the player can set a password and/or enroll a passkey (WebAuthn) for biometric/touch sign-in convenience.

## 3. Authentication
- **Primary:** email + password.
- **Convenience:** Passkey / WebAuthn (FaceID / TouchID / Windows Hello). Players may have multiple registered authenticators.
- **Magic link:** the welcome email link, plus the password-reset / account-recovery flow, is the only other ingress.
- **Admin-issued temporary password:** admins can generate a single-use temporary password for any user in their tenant. Forces a password reset on first use.
- **Forgot password:** standard email-link reset, same expiry rules as magic links.
- **Passkey reset:** a player can deregister an authenticator and enroll a new one any time, while signed in. Lost-device recovery uses the magic-link flow.

## 4. Credit (the wallet)
- Each player has a credit balance denominated in **credits** (NOT rand). Two-decimal precision; backed by an immutable ledger.
- ZAR is only the payment rail — the unit of account inside the system is credits. Top-ups convert ZAR → credits at the member's class-specific rate (Crusaders defaults: R100 → 160 credits for `Regular`, R100 → 240 credits for `LeagueOrSenior`, per blueprint A.8).
- Balance is the sum of ledger entries — never a stored field. Ledger types:
  - `top_up` (positive credits, source: PeachPayments — also captures `zar_paid` and `conversion_rate` for reconciliation)
  - `booking_charge` (negative credits, source: **lights-on activation** per blueprint A.9, NOT booking creation — see §6)
  - `cancellation_refund` (positive credits, source: mid-session cancellation after lights-on — rare; the common cancellation path produces no ledger entry because no charge happened yet)
  - `no_show_penalty` (negative credits, source: missed grace window without lights-on)
  - `late_cancellation_penalty` (negative credits, source: cancellation inside the grace window before lights-on)
  - `admin_adjustment` (positive or negative credits, source: admin override, requires reason)
  - `payment_reversal` (positive or negative credits, source: PeachPayments dispute/chargeback)
- Every entry stores: `tenant_id`, `user_id`, `amount_credits`, `zar_paid` (nullable), `conversion_rate` (nullable), `type`, `related_booking_id` (nullable), `actor_user_id`, `reason`, `created_at`, `external_reference` (PeachPayments txn id where applicable).
- Players see a running ledger in credits; admins see everyone's ledgers within their tenant.
- **Top-up flow:** player picks a ZAR amount that's a multiple of `tenant_settings.topup_block_zar` (default R100, blueprint A.3) and ≤ `tenant_settings.topup_max_zar_per_member` (default R1000) → redirected to PeachPayments → on success, the callback writes the ledger entry with the converted credits + the original ZAR + the rate used. Admins are not bound by the cap; admin manual adjustments accept any amount. See `payments-peachpayments.md`.

## 5. Court scheduling
- Each tenant has N courts (configurable, default 4 for Crusaders).

> **Crusaders client constraints** (see [blueprint](./client-blueprints/Crusaders-Blueprint-2026-05-Rev2.md)):
> - Slice length default **15 minutes** (B.4).
> - Slice price denominated in **credits** (not ZAR) — A.8 + A.9.
> - Per-member-per-day cap: max 60 minutes total (A.4 + B.3). Same-day-empty-slot relaxation: a player at the cap can still book a slot starting today if it's still empty.
> - Peak-hours league/senior exclusivity: 16:00–19:00 reserved for `LeagueOrSenior` until 1 hour before slot start; inside that window any class can book if free (A.12).
> - Admin always bypasses caps and peak-hour rules (A.6, A.11).

- The schedule is a grid: courts on the X axis, time slices on the Y axis, displayed for one day at a time.
- Slice length is configurable per tenant: 15m / 30m / 1h.
- Slice price is configurable per tenant per court (default flat across courts).
- Bookings open `T` days into the future (configurable, default 14).
- Operating hours per day per tenant: configurable (e.g. 06:00–22:00).
- Date picker lets the player navigate ±N days.
- **Slot states:**
  - `available` — green, clickable.
  - `reserved_by_me` — distinct color, shows my own name.
  - `reserved_by_other` — neutral color, shows the other player's photo + first name only.
  - `admin_block` — distinct color, label e.g. "Tournament", "Maintenance". Not bookable.
  - `out_of_hours` — greyed out, not displayed.
- **Booking action:**
  - Tap an `available` slot → confirmation modal showing court, time, duration, cost, current balance, balance after.
  - On confirm: balance must cover cost. If not, prompt to top up.
  - Booking is committed atomically: ledger debit + booking row + confirmation email + receipt PDF + webhook event.
- **Multi-slice bookings:** a player can select consecutive slots on the same court before confirming (e.g. two 30m slices = 1 hour). Each slice is its own booking row for clean cancellation accounting.
- **Recurring bookings:** out of scope for v1.

## 6. Court activation, lights-on, and the moment of charge

> **Note on charge timing.** Per blueprint A.9, the credit debit happens at lights-on, NOT at booking creation. Booking is a hold (verifies balance, reserves slot, no ledger row written). The lights-on event posts the `booking_charge` debit. This means cancellations before lights-on produce no refund (because no charge ever happened), and the no-show penalty / late-cancellation penalty rows are independent of any "original charge".
>
> **At-court payer override** (blueprint B.2): after the booked player is identified at the touchpad, a *different* identified player can press "I'll pay" and that player's account is debited instead. The booking row records both `booked_by_user_id` and `paid_by_user_id`. Both are audit-logged and emailed.

## 6a. The biometric peripheral & no-show detection
- Each court has a physical biometric peripheral attached to the on-site machine. The .NET app talks to it via `IBiometricDevice` (see `biometric-abstraction.md`).
- The court lights are switched by an Arduino + 6-channel relay on the club LAN, driven via the standard webhook system. See `lights-controller.md`.
- When a player has a booking that becomes "live" (current time falls within the booked slice):
  1. The on-court UI awaits a biometric match.
  2. On a successful match against the booked player, the mainframe fires a `booking.lights_on` webhook to the Arduino, the relay flips, and a `LightsOn` event is recorded.
  3. If no successful match within `grace_window_minutes` (configurable, default 5) past the slice start:
     - The booking is marked `no_show`.
     - `no_show_penalty` ledger entry written: `penalty_pct * slice_cost` (default 30%).
     - No-show email sent to player.
     - Webhook event fires.
  4. If a match comes in *after* the no-show was finalized, it logs but does not retroactively reverse the penalty.
- **Stand-in / different player at the court:** if biometric-matches a player who does NOT have the booking, the system rejects the lights-on. UI on the courtside terminal shows "No active booking for this user." Admin can override at the tenant console.
- **Lights stay on for the duration of the booked slice(s).** End-of-slice signals the lights to turn off; if the booking is back-to-back, lights stay on through the boundary.
- **Peripheral failure mode:** if the device is unreachable, all bookings during the outage are auto-credited (no penalty); admin gets a high-priority alert; players in the affected window get an email explaining the situation.

## 7. Cancellations
- A player can cancel any of their own bookings from the app.
- The cancellation modal clearly displays:
  - "Cancelling now is **free** — full refund to credit." (outside penalty window)
  - **OR** "Cancelling within the penalty window — **30% (R{X}) penalty** will be deducted, R{Y} refunded." (inside)
- The penalty window is defined as `≤ penalty_window_minutes` (configurable, default 15) before the slice start.
- On confirm:
  - Booking status → `cancelled`.
  - Ledger entries written (refund + optional penalty).
  - Cancellation email sent (with refund amount and any penalty explanation).
  - Slice returns to `available`.
  - Webhook event fires.
- An admin can cancel any booking; refunds always go to the booking's player. Admin can choose to waive the penalty (logged with reason).

## 8. Admin operations
A tenant admin can:
- Configure tenant settings: court count, court names, slice length, slice price (per court), penalty %, grace window, penalty window, advance-booking days, operating hours per weekday.
- Approve / reject / suspend members.
- Generate a temporary password for any member.
- **Run a biometric enrollment session for any member**, with the member physically present at a tenant machine that has a peripheral attached. Multiple finger / face templates per member supported. Re-enrollment replaces the previous template with full audit trail. See `biometric-abstraction.md` § Admin-led enrollment flow.
- Book on behalf of any member (charges that member's credit; if insufficient, admin can override and create a negative balance, logged).
- Cancel any booking on behalf of any member (penalty waiveable with reason).
- Block a slot for an event (creates an `admin_block` entry; can be a single slot, range, or recurring weekly).
- Issue a manual credit adjustment (positive or negative, reason required, logged in ledger).
- View / export all transactions, bookings, members, no-shows.
- Configure the tenant's outbound webhooks.
- View peripheral health (uptime, last-seen, error rate per court).

A platform admin can additionally:
- Onboard a new tenant (creates the tenant, the first admin user, the default settings).
- Impersonate any tenant admin (logged in audit trail).
- View aggregate platform metrics (across tenants).

## 9. Webhooks
See `webhooks.md` for delivery mechanics. Player- or admin-configurable per tenant. Event classes:
- `member.registered`
- `member.approved`
- `member.rejected`
- `member.suspended`
- `booking.created`
- `booking.cancelled`
- `booking.no_show`
- `booking.late_cancellation`
- `booking.lights_on`
- `booking.completed`
- `credit.topped_up`
- `credit.refunded`
- `credit.penalty_applied`
- `credit.adjusted`
- `peripheral.unhealthy`

## 10. Reporting
See `reporting.md`. Both players and admins get filterable, exportable transaction & activity reports. Charts where useful, never as decoration.

## 11. Notifications (email)
Every player-affecting event sends an email — this is the contractual comms channel. Webhooks mirror these for programmatic consumers but never replace them. Templates live in `src/backend/EmailTemplates/` (when scaffolded). Each email must be testable against a snapshot.

Required emails:
- Email verification (registration)
- Membership pending review (after admin notified)
- Membership approved + magic-link sign-in
- Membership rejected with reason
- Booking confirmation + receipt PDF attached
- Cancellation (free)
- Cancellation (with penalty)
- No-show with penalty
- Refund / credit adjustment
- Top-up confirmation
- Password reset link
- Magic-link sign-in
- Admin-issued temporary password
- Peripheral failure auto-credit notice

## 12. Mobile-first PWA expectations
- Installable as a PWA on iOS and Android home screens.
- Functional offline for read-only operations (view today's bookings, view balance from cache).
- Push notifications: out of scope for v1 — emails carry the load. Revisit post-pilot.
