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
   - Full name (2–120 characters)
   - Email address
   - Membership number (tenant-issued)
   - Password (at least 8 characters) — set here, not later; see §2.5
   - Photo upload (selfie, square, used as identification on the booking grid)
3. On submit:
   - Account created in `pending_approval` status.
   - Email verification link sent (24h expiry). The player can ask for it again from the sign-in screen — that request answers identically whether or not the address is registered, and spends any earlier unused link.
   - A membership number already registered in this tenant is refused as a named conflict (`membership_number_in_use`), exactly as a duplicate email is. Typing a digit of somebody else's club number is an ordinary mistake and must never surface as a server error.
   - Player sees "We've emailed you to confirm your address. After confirmation, an admin will review and approve your membership."
   - All tenant admins notified (email + in-app).
4. Admin reviews in their console. **Review is not gated on the applicant having confirmed their address** — an admin may reach a pending application first, and nothing about approval depends on the verification link having been clicked:
   - **Approve:** account becomes `active`. Welcome email goes out with a one-time magic-link sign-in (short-lived JWT in querystring, single-use, ≤15 min expiry). Consuming that link **confirms the address**, because clicking a link delivered to a mailbox is proof of control of that mailbox; an approved member is therefore never left able to sign in one way and refused the other. Webhook event fires.
   - **Reject:** admin must enter a reason (free text). Account becomes `rejected`. Rejection email sent with the reason. Webhook event fires.
5. Once `active`, the player can **change** their password and/or enroll a passkey (WebAuthn) for biometric/touch sign-in convenience. (Earlier revisions of this section said "set a password" here, as though registration did not take one. It does — §2.2 — and the account-recovery paths in §3 are what set a password for an account that has none.)

## 3. Authentication
- **Primary:** email + password.
- **Convenience:** Passkey / WebAuthn (FaceID / TouchID / Windows Hello). Players may have multiple registered authenticators.
- **Email confirmation is a precondition of password sign-in**, and of nothing else. An unconfirmed address is refused with its own error code (`email_not_verified`), never collapsed into the not-approved refusal — they are different problems with different repairs, and the sign-in screen offers the repair for each. The welcome magic link is the one ingress that does not require prior confirmation, because consuming it *is* the confirmation (§2.4).
- **A decision the club has already taken outranks an unconfirmed address.** A membership that is `rejected` or `suspended` is refused as exactly that (`not_approved`, carrying the status), whether or not the address was ever confirmed: confirming an address cannot un-reject an application or lift a suspension, so asking for it there offers a repair for a problem the member does not have — and following it through lands on "an admin will review your application", which for a rejected applicant has already happened and was a refusal. A membership still `pending_approval` is the opposite case and keeps the `email_not_verified` refusal, because confirming is precisely what it still owes. The sign-in screen names all three separately — suspended, rejected, awaiting review — and offers the resend only for the third.
- **Suspension ends the session that is already open, not only the next one.** Access tokens are short-lived and renewed in the background for as long as a tab is open, and the renewal re-applies the membership test the sign-in path applies. A member suspended at the desk is therefore signed out at their next renewal — without it, the sign-in screen refused them while their open tab renewed itself indefinitely and kept reading their wallet, their ledger and the schedule.
- **Magic link:** the welcome email link, plus the password-reset / account-recovery flow, is the only other ingress.
- **Admin-issued temporary password:** admins can generate a temporary password for any user in their tenant. It **forces a password reset on first use**, and that is enforced at the API rather than by routing the browser: a session authenticated with a temporary password is refused on every endpoint except the one that replaces the password (`403 password_change_required`). The temporary password stops working at the moment it is replaced, which is also the only way the forced state is cleared.
  - Earlier revisions called it "single-use". It is not single-use in the literal sense — a member who abandons the change screen can sign in with it again — and it must not be, or a mistyped new password would lock the account out entirely. What "single use" is protecting is that the password an admin saw on their screen and emailed in plaintext never becomes the account's standing credential, and the API refusal above is what actually guarantees that.
- **Forgot password:** standard email-link reset. The reset token is **valid for one hour and works once**. This is deliberately longer than the ≤15-minute magic link: a member clicks an approval link while they are waiting for it, and reads a reset email whenever they next open their inbox. (Earlier revisions said "same expiry rules as magic links", which the implementation has never matched.)
- **Passkey reset:** a player can deregister an authenticator and enroll a new one any time, while signed in. Lost-device recovery uses the magic-link flow.
- **Changing your own password:** available to any signed-in member with a password, requiring the current one. A wrong current password is refused as a bad field (`400`), never as an expired session — a `401` on an authenticated route is the client's sign-out signal, and answering one here would sign a member out for a typo. Every successful change emails the member, which is how they would learn that somebody else made it.

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
- Operating hours per day per tenant: configurable (e.g. 06:00–22:00). Held as `tenant_settings.operating_hours`, a per-weekday map; the flat `day_start_minute` / `day_end_minute` pair is the default for any weekday the map does not name. **Enforced by `BookingService`, not only drawn by the grid** — a member who reaches the API directly is refused `out_of_hours` with that day's opening and closing times, because a slot sold outside hours is a slot the grid cannot draw and the member therefore cannot see, cancel or be refunded from the app. A walk-up bought while the club is OPEN is truncated at closing rather than refused; one attempted while the club is SHUT is refused `club_closed`, carrying that day's opening and closing times so the box can put them on the glass. It used to collapse into the catch-all `walk_up_refused`, which is in no firmware table, so a member at a locked club after hours read SEE THE DESK when there is no desk (finding M-F5). `club_closed` is deliberately a different code from the app's `out_of_hours`: that one means the slot you picked is outside hours and can be answered by picking another, this one means the club is shut right now and cannot. Admins bypass, so maintenance and events can be booked out of hours.
- Date picker lets the player navigate ±N days. Forward is bounded by `advance_booking_days`; backward the player may look at the same number of days into the past, read-only — a past day's slots are never bookable, and until there is a bookings list elsewhere in the product this is the only way a player can review a booking they have already played.
- **Slot states:**
  - `available` — green, clickable.
  - `reserved_by_me` — distinct color, shows my own name.
  - `reserved_by_other` — neutral color, shows the other player's photo + first name only.
  - `admin_block` — distinct color, label e.g. "Tournament", "Maintenance". Not bookable.
  - `out_of_hours` — greyed out and not bookable. *(This line used to read "greyed out, not displayed", which asks for two contradictory things. Rendered-and-inert is the reading that keeps the grid legible: a row that vanishes leaves the player unable to tell a closed club from a bug, and a booking that already exists outside hours — an admin block, a walk-up that ran to closing, a slot sold before the rule was enforced — must still be visible to its owner. The grid draws the day's operating window plus whatever range any existing booking on that day occupies.)*
- **Booking action:**
  - Tap an `available` slot → confirmation modal showing court, time, duration, cost, current balance, balance after.
  - The modal has an explicit confirm control and **no timer**: it stays open until the player confirms or dismisses it. A confirmation that disarms itself after a few seconds is a price the player was not given time to read.
  - On confirm: balance must cover cost. If not, prompt to top up.
  - Every refusal carries a stable snake_case `error` code and the figures its sentence needs — `past_time`, `too_far_ahead`, `slot_taken`, `invalid_duration`, `insufficient_balance`, `peak_hours_league_only`, `per_day_cap_exceeded`, `out_of_hours`, `no_time_available`, `duplicate_request`, `court_not_found`. **A rule refusing a booking is never a 5xx.** The client maps codes to sentences; a code or an exception is never shown to a player.
  - Booking is committed atomically: ledger debit + booking row + confirmation email + receipt PDF + webhook event.
- **Multi-slice bookings:** a player can select consecutive slots on the same court before confirming (e.g. two 30m slices = 1 hour). Each slice is its own booking row for clean cancellation accounting.
- **Recurring bookings:** out of scope for v1.

## 6. Court activation, lights-on, and the moment of charge

> **Note on charge timing.** **The debit happens at booking, not at lights-on.** `BookingService.CreateAsync` reserves the slot and posts the `BookingCharge` debit in the same unit of work, so a lost slot race cannot leave a member paying for a court they did not get. Cancelling before check-in refunds in full, less the late-cancellation penalty inside the penalty window; once someone has checked in there is nothing back. This **contradicts blueprint A.9**, which debits on lights-on; the deviation is the founder's decision, is recorded in `client-blueprint-deltas.md`, and needs committee sign-off before go-live. The normative statement of what a booking owes in every terminal state is `settlement-model.md` §2 — read that, not this note, when the answer has to be right.
>
> **At-court payer override** (blueprint B.2): after the booked player is identified at the touchpad, a *different* identified player can press "I'll pay" and that player's account is debited instead. The booking row records both `booked_by_user_id` and `paid_by_user_id`. Both are audit-logged and emailed.

## 6a. The biometric peripheral & no-show detection
- Each court has a physical biometric peripheral attached to the on-site machine. The .NET app talks to it via `IBiometricDevice` (see `biometric-abstraction.md`).
- The court lights are switched by the **court box** (ESP8266 bridge + Mega relay bank with an independent auto-off timer), which decides locally from an online activation or its cached heartbeat roster and pulls everything from the API; it is never a webhook destination. `lights-controller.md` (webhook-driven Arduino) is superseded — see `device-serial-protocol.md` and *the court box and its key* below.
- When a player has a booking that becomes "live" (current time falls within the booked slice):
  1. The on-court UI awaits a biometric match.
  2. On a successful match against the booked player, the mainframe fires a `booking.lights_on` webhook to the Arduino, the relay flips, and a `LightsOn` event is recorded.
  3. If no successful match within `grace_window_minutes` (configurable, default 5) past the slice start:
     - The booking is marked `no_show`.
     - `no_show_penalty` ledger entry written: `penalty_pct * slice_cost` (default 30%).
     - No-show email sent to player.
     - Webhook event fires.
  4. If attendance evidence arrives *after* the no-show was finalized — an `activation` event a box queued through an outage — the sweep is **reversed**: the booking returns to the attended state and `Owed(b)` returns to the full price, so the member is neither refunded nor penalised for a court they played. `settlement-model.md` §2, S6. (This is the C2/C6 pair: the earlier behaviour left a member who had played both refunded *and* penalised.)
- **Stand-in / different player at the court:** if biometric-matches a player who does NOT have the booking, the system rejects the lights-on. UI on the courtside terminal shows "No active booking for this user." Admin can override at the tenant console.
- **Only an `active` membership opens a court, and that holds on every device path.** A membership that is `suspended`, `rejected` or still `pending_approval` may not light a booked court and may not buy a walk-up — the suspension email and the console's own suspend dialog both promise it in those words. Enforced in four places because there are four doors: the app's booking route (`member_suspended`, 403), the activation candidate set (`/device/activate`, the courtside PIN/QR/biometric match — all of which answer their ordinary `no_booking`), the walk-up (`/device/walkup`, answered `not_recognised` **before** anything is charged, so the box arms no button window and shows SEE THE DESK), and the cached heartbeat roster, so the rule survives an outage. The box never names the reason: whoever is standing at the court is not necessarily the member. **The one deliberate exception is `/device/events`** — an activation a box already decided from a roster fetched before the club's decision is still recorded as attendance, because the relay has run and the member has played; refusing it would refund a court that was used and waive the penalty, which is the opposite of what the suspension is for.
- **Lights stay on for the duration of the booked slice(s).** End-of-slice signals the lights to turn off; if the booking is back-to-back, lights stay on through the boundary.
- **Peripheral failure mode.** A box is *unreachable* when the API has not heard from it **at all** for longer than `offline_after_seconds` — the same threshold the Devices page reads, derived from the club's own `heartbeat_seconds`. *Heard from* is any authenticated call the box makes: `/heartbeat`, `/events`, `/activate` or `/walkup`. It used to be the heartbeat alone, and a box that was actively switching courts on through `/activate` therefore counted as silent — the club got the high-priority alert while the box was mid-scan, the Devices page read "last seen 11m ago" beside a court it had just lit, and the waiver below then refunded that court's no-shows and waived the penalty (finding L-F5). Anything that breaks the periodic POST while leaving request/response working — a stalled firmware timer, a rate limit, a proxy that buffers — converted into free courts and alert noise, and no screen said why. `PeripheralHealthWorker` sweeps for it, and three things follow:
  1. **The club's admins get a high-priority alert** — a real `X-Priority: 1` mail naming the box and the courts it drives, plus a `peripheral.unhealthy` webhook. Once per outage, and a `peripheral.recovered` when it comes back.
  2. **No penalty is charged for a booking the outage covered.** A booking whose court had no reachable box *at the moment its grace window closed* is refunded in full and charged nothing: `Owed(b) = 0`, `settlement-model.md` S5a. That is this clause's "auto-credited (no penalty)". **"No reachable box" is the same test as everywhere else in this section** — silent for longer than `offline_after_seconds`, measured at the grace deadline against the last heartbeat that preceded it — applied to **every** enabled box that drives the court, not to whichever one happens to be dark. A court with two boxes on it is dark only when both are past the threshold; a court with none is not dark at all. (A club that replaces a box and leaves the old row enabled has one box silent forever on that court, and the looser reading would waive every no-show there permanently — `settlement-model.md` S5a, "How many boxes have to be dark".) It is deliberately not "an outage row happens to span the deadline", and equally not "whatever the box's last heartbeat says right now": the first made the price depend on whether the health sweep had run yet, the second on whether the box had come back yet, and both priced identical facts two ways. A silence past the threshold is recorded when it *ends*, by the heartbeat or upload that ends it, so the evidence survives the recovery that would otherwise erase it. **And a box only speaks for deadlines it existed at** — see the bullet below, because auto-registration otherwise turned any spare board into a veto on this clause.
  3. **The affected players are told why** — a distinct email that explains the controller was offline, states the full refund and says no penalty was taken. Not the no-show notice: a member standing at a dark court has not failed to turn up.
- **A board that did not exist at the deadline is not evidence about it.** `AutoRegisterAsync` is the whole of provisioning: an unknown MAC that announces itself is put straight onto the club's first four courts, `Enabled` true, with nobody having confirmed that it drives any of them — that is what makes a box useful the moment it is switched on. Combined with "every enabled box on the court has to be dark", it silently reversed this clause: **one healthy unconfigured board vetoed the waiver on courts 1–4**, so a spare on the desk, or the replacement an admin plugs in while the dead one is still in the cupboard, made every member on a dark court pay the 30% for the club's own hardware. Under the older "any dark box waives" rule an extra board could only ever *add* waivers; the all-boxes rule gave an extra board the power to *remove* them, and neither spec said so. A box therefore counts, in **either** direction, only from the earliest instant it is known to have existed — the earliest of its row's `CreatedAt`, its `LastSeenAt`, and the start of any silence recorded for it. Before that it is skipped entirely rather than treated as dark, so a court whose only box arrived after the deadline is "not dark" for the same reason a court with no box is. Pinned by `A_board_that_appeared_after_the_deadline_does_not_block_the_waiver` and `A_board_already_installed_at_the_deadline_still_blocks_the_waiver`, which differ only in the board's install date.
  - **Not "auto-registered boxes never vote", which was the other candidate.** Excluding them from the veto alone would waive every no-show on a court whose only box is a healthy unconfirmed one — a club that has not been through its Devices page yet would collect no penalties at all. Excluding them in both directions, the way a disabled box is excluded, would deny §6a's protection to the members of exactly that club, which is the direction this clause exists to prevent. Existence is the narrower rule and it removes the actual exposure: every real instance of it — the bench spare, the replacement, the board an installer plugs in mid-week — is a board that appeared *after* the deadline it was voting on. What it leaves is a board that has sat auto-registered and heart-beating on guessed courts since before the booking; that one still votes, and the Devices page flags it as unconfirmed.
- **What §6a does *not* mean, and why.** It does **not** mean every booking in the outage window is cancelled and refunded on sight. The box is built to survive losing its uplink — it lights courts from its cached roster and queues the activations (see 4 above) — so "unreachable from the API" is not "the member was locked out". Refunding a court that was played would break `settlement-model.md` I2 and pay out for electricity the club burned. The refund therefore rides the no-show sweep, which is the only point at which the system concludes that nobody played; and if the box was in fact lighting courts, its queued activations arrive **on reconnect provided the box stayed powered**, reverse the sweep, and `Owed(b)` returns to the full price with no penalty either way (S6).
- **The case where that proviso fails, and what it costs.** The event queue is RAM (`src/iot/lib/eventq/include/eventq/EventQueue.h`), so a box that lit courts from its cached roster and then lost power never uploads those activations. S6 never happens and the full refund stands on a court that was played — the single accepted exception to I2, recorded there and on the go-live checklist. It used to cost the member an unearned penalty, which they could see and dispute; it now costs the club and is invisible, which is why the outage alert does not tell an admin to power-cycle the box and the recovery mail does not promise that everything uploads.
- **Why the grace deadline is the instant that decides it.** A box that reconnected before the deadline uploads what it queued through the outage **provided it stayed powered** — the ring is RAM — so if the member played we usually already know it and the booking does not reach the sweep at all. The word is *usually*, not *always*, and the bullet above is the exception: the same power cut that ended the outage discards the queue, and that case is the one accepted I2 exception rather than something this clause rules out. A box still dark at the deadline is one whose evidence had no path home.

## 7. Cancellations
- A player can cancel any of their own bookings from the app.
- The cancellation modal clearly displays:
  - "Cancelling now is **free** — full refund to credit." (outside penalty window)
  - **OR** "Cancelling within the penalty window — **30% ({X} cr) penalty** will be deducted, {Y} cr refunded." (inside)
  - **OR** "You have already checked in — the lights have been on, so **nothing is refunded**." (after check-in; `settlement-model.md` §2 S4)
- **The figures come from the server, at the moment the modal opens** — `GET /api/v1/bookings/{id}/cancellation-quote`, computed through the same settlement the cancellation itself uses. They are not carried on the schedule payload and not re-derived in the client: the answer turns on the clock (the penalty window) and on attendance (a scan at the court), and both move after a schedule is loaded. The quote is a quote, not a reservation — the cancellation re-derives everything, and the confirmation states what actually moved.
- The confirmation after a cancellation names the actual figures returned by the cancel call. "Refund pending" is not an acceptable message: it was shown identically when 50 credits came back, when 35 did, and when nothing did.
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
- **Book on behalf of any member.** Charges that member's credit and never the admin's — a
  desk account's balance is zero permanently, because it never plays. If the member cannot
  cover the court the booking is **refused first**, with their balance and the price on the
  refusal; the admin can then override that refusal and take the member below zero. The
  override is deliberate, not a bypass admins get for being admins:
  - It is asked for **by name** — `allowNegativeBalance` on `POST /api/v1/admin/bookings` —
    on a second attempt, after the desk has read the two figures. The confirmation modal
    shows the member's name, their balance, the price and the balance it will leave, and the
    override button states that balance in its own label.
  - It is honoured **only when the actor differs from the payer**, so an admin cannot
    overdraw their own wallet with it and a member has no route to it at all: the field does
    not exist on the member's own booking request, and the service would refuse it anyway.
  - It is **logged** as `booking.created_on_behalf_overdrawn`, carrying the actor, the
    member, and the balance before and after. An override the member turned out to be able
    to afford is audited as an ordinary `booking.created_on_behalf` — the trail records the
    outcome, not the request.
  - Nothing else about the booking changes: one `BookingCharge` at the quoted price, so
    `settlement-model.md` S1 still says `Owed(b) = P` and I1 still bounds it. What goes
    negative is the **wallet**, which is a sum over the ledger and has never been constrained
    to be non-negative; an ordinary top-up nets against it, because there is no separate debt
    record to reconcile.
  - The member's confirmation email states the negative balance and asks them to top up.
    Being in the red is not a suspension and does not block anything by itself.
- Cancel any booking on behalf of any member (penalty waiveable with reason).
- Block a slot for an event (creates an `admin_block` entry; can be a single slot or a range). `POST /api/v1/admin/blocks` creates one, `DELETE /api/v1/admin/blocks/{id}` lifts it. A block reserves the court through the same overlap exclusion constraint a booking does, takes no money and writes no ledger row. It **cannot be laid over an existing booking** — a player who paid must be refunded deliberately, through a cancellation, rather than overwritten. Lifting a block cancels rather than deletes it, so the trail survives. *Recurring weekly blocks are out of scope for v1, alongside recurring bookings (§5); a range is created as one block per slot run.*
- The three admin actions above — book on behalf, cancel any booking with an optional waived penalty, and block — are reachable **from the schedule grid**, on the slot they act on. The endpoints existing without a screen is the same defect as the screen existing without the endpoints.
- Issue a manual credit adjustment (positive or negative, reason required, logged in ledger).
- View / export all transactions, bookings, members, no-shows.
- Configure the tenant's outbound webhooks.
- View peripheral health (uptime, last-seen, error rate per court).
- Configure the court-box **button map** — the club default and, per box, an override (below). Both live on the Devices page, not this one; see §8a.

### 8a. Court-box button map
A court box has eight physical buttons (`ButtonMap.ButtonCount`), wired A/B/C/D then 15/30/45/60. The Mega reports raw presses and the bridge decides, so any button can be mapped to any action: select a court (by position in the box's own court list, relays A–D) or grant a number of minutes (bounded by the relay hard cap, `ButtonMap.MaxGrantMinutes`).

- **Club default:** `tenant_settings.buttons`, edited on the **Devices page**, beside the per-box override it is the fallback for. (This line used to say the Settings page, and the build has never done that. The two maps are validated against each other on every edit — an override is refused when it reaches past its box's court list, and the club default is refused when any box running it would — so an admin editing one needs the other in front of them. Splitting them across two screens would mean reading a refusal on one page about a value set on another.) The default map is the wiring's original meaning, so a club that never touches it gets exactly what the hand-built box did.
- **Per-device override:** `button_map` on `PATCH /admin/devices/{id}`, stored as `Device.ButtonMapJson`. It is three-valued: absent leaves the override alone, `null` clears it (the box runs the club default), a list of eight entries sets it.
- **Validated per box, not per club.** The *effective* map — the override if any, else the club default (`ButtonMap.EffectiveFor`) — is checked against that box's court list on every edit: a map whose court button reaches past the box's list is refused with `button_map_selects_court_beyond_device_courts` and the map named. A one-court annex box and a four-court main box can therefore both be valid under one club default, each with its own override where needed; the old single tenant-wide validation had no valid configuration for a mixed fleet.
- **A box that registers itself is given a map it can honour.** Auto-registration stores the club's map trimmed to the box's court count when the club's map reaches past it, rather than leaving buttons that select nothing — the same rule as shrinking a box's court list by hand.
- **The heartbeat also sends `walk_up_max_minutes`** — `min(tenant_settings.walk_up_max_minutes, relay hard cap)`, the same bound `/device/walkup` enforces, so the box is never told a number the API will refuse. It was not sent, and the two screens that set these numbers did not know about each other: a club that lowered its walk-up maximum to 20 left every box still advertising 15/30/45/60 and the API refusing three of the four presses with `minutes_out_of_range` — the club's own configuration change, blamed on the member, at a court with nobody at the desk (finding M-F1). The Devices page now warns beside any minute button that exceeds the cap, naming the number and where it is set; it does not refuse the save, because the cap can be raised afterwards and a button map that anticipates that is not wrong.
- **The heartbeat sends the effective map** (`button_map` in the heartbeat response, `ButtonMap.EffectiveFor(device.ButtonMapJson, settings.Buttons)`), so the box never has to know whether it is running an override. The Devices screen renders the override editor only when the API carries the field.

### 8b. The court box and its key
One club, one key, and a box that introduces itself.

- **Authentication is one static key per club.** Every device request carries `Authorization: Bearer <device_api_key>`; the key resolves to a tenant and to nothing finer. An admin reads it from `GET /api/v1/admin/devices/api-key` (the Devices page) and pastes it into the box's `secrets.h`; `POST /api/v1/admin/devices/api-key/regenerate` replaces it, invalidating the old one on the very next request, so every box must be reflashed.
- **Identity is the MAC in the request body.** `mac` (twelve lowercase hex, no separators) names the board on `heartbeat`, `activate`, `walkup` and `events`. It authenticates nothing — the key does that — it only says which row a request is about.
- **Registration is a heartbeat.** An unknown MAC creates a `Device` for the key's tenant: `device_code` `box-<last six hex of the mac>`, the club's court numbers ascending up to the four the relay bank drives, the club's button map trimmed if it does not fit, audited as `device.auto_registered` and flagged `auto_registered: true` on the wire until an admin edits the row. The Devices page badges it so the guessed court numbers get checked.
- **Admin can edit, take out of service, and delete.** Deleting is a reset rather than a revocation: the board still holds the club key, so it re-registers with default courts on its next heartbeat — which is why it is useless for a box that is broken but still powered. **Out of service** (`enabled`) is the lever for that one: the API refuses a disabled box on every endpoint, `PeripheralHealthWorker` stops alerting on it, and `DeviceOutageIndex` stops counting it when deciding whether a court is dark. The field had been on the API, on the typed client and in the settlement model since the row existed and **no screen ever sent it** (finding M-F3), so a box that was broken or unplugged for good alerted the club indefinitely about a silence nobody could stop, and — because a court is dark only while every enabled box driving it is dark — kept its courts dark for ever, waiving the 30% no-show penalty on them permanently. Note the other direction, which the console says out loud: taking the LAST box off a court leaves that court with no box at all, and a court with no box is not dark, so its no-shows are charged as normal again.
- **The Devices page is a live view, not a snapshot.** It re-reads the boxes every 15 seconds — one beat of the fastest cadence the firmware will run — and offers a Refresh control and the time of its last read. It loaded once on mount and never again, which mattered because the peripheral-health alert email links to this page and asks an admin to watch the box come back: an open tab read "online" for a box six and a half minutes dark, long after the club had been emailed about it, while a second tab on the same URL read "last seen 6m ago" (finding M-F2). A box that has gone quiet on its own is shown as *not reporting*; a box an admin switched off is shown as *out of service* and never as offline, because nobody expects it to call in.
- **Gone:** discovery, claim codes, per-device keys, key rotation, reclaim, revoke, manual registration, request signing, the clock window and over-the-air updates. All of it existed to deliver or repair a credential an admin could never read back, and each link could strand a board in a cupboard. See `deployment.md`.

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
- `member.reactivated`
- `booking.created`
- `booking.cancelled`
- `booking.no_show`
- `booking.no_show_reversed`
- `booking.late_cancellation`
- `booking.lights_on`
- `booking.lights_off`
- `booking.completed`
- `booking.displaced`
- `booking.displacement_reversed`
- `booking.cancelled_lights_charged`
- `credit.topped_up`
- `credit.refunded`
- `credit.penalty_applied`
- `credit.adjusted`
- `peripheral.unhealthy` — a court box has stopped heart-beating for longer than `offline_after_seconds` (`HeartbeatCadence`, derived from the club's own `heartbeat_seconds`). Fires **once per outage**, not once per sweep, and carries the box, its MAC, the courts it drives and how long it has been silent. `PeripheralHealthWorker`.
- `peripheral.recovered` — the same box called in again. Carries the outage's length.

**On `peripheral.unhealthy`, and a correction.** This class was previously marked "specified,
not emitted in v1", on the grounds that reinstating it "needs a real peripheral driver, or a
device-side liveness signal, first". **The second half of that was false**, and it was believed
for a round. The liveness signal exists and the product already used it: the court box PUSHES
`POST /api/v1/device/heartbeat`, which writes `Device.LastSeenAt`; `HeartbeatCadence` already
computed the threshold; `DeviceView` already shipped it as `offline_after_seconds`; and the
admin Devices page already rendered "offline" from it. The only missing piece was a sweep. The
*first* half remains true and is a different thing: `BiometricDeviceState.Faulted` is still set
by no driver, because `NullBiometricDevice` is the only implementation — so this event means
"the box is not reporting", never "the reader is faulty". A fingerprint reader that fails while
its box keeps heart-beating is still invisible, and will be until a driver exists. `GET
/admin/reports/peripheral-health` remains a counts report (24-hour webhook-delivery and
biometric-match totals), not a device state.

The destination of an endpoint is guarded against SSRF (`webhooks.md`), with a carve-out
for LAN consumers. **That carve-out is deployment configuration and has no admin screen,
deliberately** — the allow-list is process-wide, so one club editing it would move the
boundary for every other club on the deployment. The refusal an admin sees says exactly
that, and names the setting so they can ask their operator for it. Reasoning:
`webhooks.md` § *The LAN carve-out*.

## 10. Reporting
See `reporting.md`. Both players and admins get filterable, exportable transaction & activity reports. Charts where useful, never as decoration.

## 11. Notifications (email)
Every player-affecting event sends an email — this is the contractual comms channel. Webhooks mirror these for programmatic consumers but never replace them. Templates live in `src/backend/EmailTemplates/` (when scaffolded). Each email must be testable against a snapshot.

Required emails:
- Email verification (registration) — also re-sendable on request from the sign-in screen
- Membership pending review (to the applicant)
- **New membership application (to every tenant admin)** — the "admin notified" half of §2.3. It went unsent for a long time: both registration mails went to the applicant, so the only cue an admin ever had was a pending counter on a screen they had to think to open.
- Membership approved + magic-link sign-in
- Membership rejected with reason
- Booking confirmation + receipt PDF attached
- Cancellation (free)
- Cancellation (with penalty)
- No-show with penalty
- Refund / credit adjustment
- Top-up confirmation
- **Top-up not completed** — declined, cancelled at the gateway, or settled for an amount other than the one it was registered for. Confirmation was emailed and failure was silent, so the one terminal outcome of a member handing over card details that sent nothing was the one where they most needed telling: a member who closed the tab after PayFast could only learn what happened by finding the status page again. `TopUpStatus.tsx` promises this mail in as many words on the branch where it cannot reach the club ("we'll email you either way"), which is exactly the branch where it is the only channel left. Cancellations get it too, because "either way" is what the screen says and a member who backed out still deserves to know nothing was taken. **Once per top-up, not once per ITN retry** — PayFast retries a notification until it is acknowledged and the handler's idempotency check short-circuits only on `Completed`. `provider_register_failed` is excluded: it happens while the member is still looking at the top-up form and reading the error, and no status page exists for it to promise anything from.
- Password reset link
- Magic-link sign-in
- Admin-issued temporary password
- **Password changed** — sent on every self-service change, including the member's own. It is the one signal a member has that somebody else changed it.
- Peripheral failure auto-credit notice

## 12. Mobile-first PWA expectations
- Installable as a PWA on iOS and Android home screens.
- **The offline shell covers the app itself, not the member's data.** Opening the installed app
  with no signal gets the interface — the shell, the build assets, the icons — rather than the
  browser's offline page. Balances, bookings, the ledger and the profile all require the network.
  This line previously read "functional offline for read-only operations (view today's bookings,
  view balance from cache)", and that promise was withdrawn on 2026-09-05 because it cannot be
  kept safely on a shared device: the browser's Cache API keys entries on the request URL and
  ignores the `Authorization` header, and its storage belongs to the browser profile rather than
  to a login. A club-desk tablet therefore served the second member to open the wallet the first
  member's balance and ledger, and a cached session probe could boot the app under the first
  member's identity and admin flag. **No response carrying member data may be cached by the
  service worker.**
- **The narrowing is ratified on its merits, and the reason first recorded for it was false.**
  That reason said per-session cache keying — a cache named for the token's subject, every other
  session's cache evicted on first sight of a new one — had to be rejected because it could not
  be exercised in this repo's automation. It can: a service worker registers on the first attempt
  in the Chromium Playwright already drives here, and `src/frontend/e2e/service-worker.spec.ts`
  now registers the real worker, reproduces the two-member leak against the old version and holds
  the current rule. What the decision actually rests on, corrected 2026-09-05: (a) not caching
  member data has no failure mode, while per-session keying has one that is silent — the cache
  still answers, just with the wrong member's body; (b) it would make a privacy boundary depend on
  the page's own guess at who is signed in, at the moments the page is least sure (a token that
  expired while the tab was closed, a session ended in another tab, an admin acting on behalf of a
  member); (c) what it would buy is a stale balance, and a balance that is not the ledger is the
  one number this system may not show — nor could a member act on it, because every booking,
  cancellation and top-up needs the network. **The price is accepted and is real:** a mobile-first
  PWA whose members cannot read their balance where there is no signal. Revisit only with a design
  that survives two members sharing one device — and it is now testable, so a revisit must arrive
  with the test.
- Push notifications: out of scope for v1 — emails carry the load. Revisit post-pilot.
