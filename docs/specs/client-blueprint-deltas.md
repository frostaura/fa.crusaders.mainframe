# Client Blueprint — Implementation Deltas

A line-by-line reconciliation of [`client-blueprints/Crusaders-Blueprint-2026-05-Rev2.md`](./client-blueprints/Crusaders-Blueprint-2026-05-Rev2.md) against the build as of 2026-08-23. Four columns:

- ✅ **Done** — implemented and matches the client's requirement.
- 🟡 **Adjust** — implemented but the client requirement narrows / changes the parameters.
- 🆕 **New** — not in the current build; needs design and code.
- ⚠️ **Deviation** — built deliberately **against** the blueprint. The blueprint is the
  customer's own word and outranks internal specs on economics, so a deviation is not a
  decision this repo gets to make alone: each one is listed under
  [Deviations needing committee sign-off](#deviations-needing-committee-sign-off) and
  **must be signed off before go-live**.

## Reconciliation table

| Req | Status | Notes |
| --- | --- | --- |
| A.1 — book on a cell-phone app | ✅ | Mobile-first responsive PWA. |
| A.2 — ID + password / thumbprint, admin approval | ✅ | Registration → email verify → admin approval → password + WebAuthn passkey login. |
| A.3 — top-up in **R100 blocks**, max **R1000** for members, **admin unlimited** | ⚠️ | **Superseded by [D-3](#d-3--minutes-packages-replace-credits-the-r100-block-and-the-r1000-cap) (P13, 2026-10-01):** members buy admin-defined **minutes packages** with **no cap** and no block; the desk sells packages over the counter. |
| A.4 — 2-week horizon, **1 hour / day per member** | 🟡 | 14-day horizon already there. **New rule:** per-member-per-day max minutes (default 60), enforced at booking-create. Admin can override. |
| A.5 — unfunded accounts can't book | ✅ | `BookingResult.InsufficientBalance` already returned 402. |
| A.6 — admin override unlimited | ✅ | Admin booking endpoint bypasses windows + caps. |
| A.7 — **two member classes:** member, league/65+ | 🆕 | ~~Add `MemberClass` enum to `Membership`.~~ **Superseded by D2 (2026-09-23):** the class is removed and GROUPS carry it — the league group (system key `league`) holds the A.8 league rate and the A.12 peak priority; `GroupsReplaceClass` moved every `LeagueOrSenior` member into it. Same economics per member; any number of groups beyond the two. |
| A.8 — **differential top-up rates by class:** R100 → 160 credits (Regular) / 240 credits (League/65+) | ⚠️ | **Superseded by [D-3](#d-3--minutes-packages-replace-credits-the-r100-block-and-the-r1000-cap) (P13, 2026-10-01):** the ledger unit is **whole minutes**; a booking costs its own length. The league advantage is a configurable **package discount** on the league group (rand only, lowest discount wins), not a conversion rate. |
| A.9 — **debit on lights-on**, not on booking | ⚠️ | **Built the other way, on purpose.** `CreateAsync` posts the `BookingCharge` debit at booking time; the court settles only *who* pays. See [D-1](#d-1--the-debit-happens-at-booking-not-at-lights-on) — **needs committee sign-off**. |
| A.10 — league games booked by admin, paid by member | ✅ | Admin booking-on-behalf charges the member's credit. |
| A.11 — admin override for control | ✅ | Audit-logged. |
| A.12 — **peak-hours league exclusivity (16:00–19:00)** | 🆕 | At booking-create, if the slot is in peak hours **and** any league/65+ member could plausibly want it, refuse Regular bookings. Implementation: simple rule — Regular members cannot book peak slots earlier than `T-now` (e.g. earlier than 1 hour before slot start). Inside the last hour, peak slots open up to anyone if still empty. Configurable. |
| B.0 — biometric / face / QR (do away with cards) | 🟡 | Biometric is in. **New:** add QR-code / personal-code / cell-phone code as alternative ident methods. See "Identification triple-stack" below. |
| B.1 — touch pads outside both doors | ✅ | Court-side terminal is the existing courtside UI; one per court door. Hardware install is a Phase 7 deployment task. |
| B.2 — **at-court payer override** ("someone else to pay") | 🆕 | New flow: at the courtside terminal, the *booked* player or a different identified player can press "I'll pay for this" → that player's credits are debited instead of the original booker's. The booking row records both (`booked_by_user_id`, `paid_by_user_id`). |
| B.3 — 1-hour-per-day rule, only same-day relaxation | 🟡 | Same as A.4. The "unless courts are available" clause means: same-day, if a slot is empty and a member is over their daily cap, they can still book it. Implementation: cap applies only at-or-before `slot_starts_at - 0` for slots ≥ today; strict for advance bookings. |
| B.4 — **15-minute slices** | 🟡 | Slice length is configurable; change Crusaders default seed from 30 → 15. |
| B.5 — top-up prompt on insufficient credit | ✅ | Frontend already redirects to `/wallet/topup`. |
| C.1 — admin sees who booked (name / ref / status) | ✅ | Admin schedule view + members list. |
| C.2 — booking history by member | ✅ | `/api/v1/admin/members/{id}/bookings` derivable from existing data; surface in admin UI. |
| C.3 — spend by member | 🟡 | Ledger filter exists; admin UI to drill into a specific member's spend graph is the polish item. |
| C.4 — monthly reports | ✅ | Reports endpoints already accept `from`/`to`; UI already has a date picker. Add "This month" / "Last month" presets to the date picker. |
| D.1 — **2-year retention of usage history** | 🆕 | Background worker that nightly deletes audit-log + biometric_match_events + bookings (status=Completed/NoShow) older than 2 years. Configurable. |
| D.2 — admin manages member data | ✅ | Admin members + ledger pages cover this. |
| D.3 — POPI compliance | 🟡 | Founder direction (2026-05-06) was "forget about legislation for now." This requirement is captured but not in the immediate build scope. |

## Architectural changes — the four big ones

### 1. Credits as the unit of account (not ZAR)

> **Historical — superseded by [D-3](#d-3--minutes-packages-replace-credits-the-r100-block-and-the-r1000-cap)
> (P13, 2026-10-01).** The unit of account is whole minutes and members buy packages; the
> contract is [`minutes-and-packages.md`](./minutes-and-packages.md). This section is kept as
> the record of what was built before.

The ledger is denominated in **credits**. Top-ups convert ZAR → credits at the member's class-specific rate, stored as conversion metadata on the ledger entry so the conversion is auditable.

**Schema:**
- `LedgerEntry.AmountCredits` decimal(10,2) — replaces `AmountZar`.
- `LedgerEntry.ZarPaid` decimal(10,2) **nullable** — populated on `TopUp` rows from the Peach payment, null on internal entries.
- `LedgerEntry.ConversionRate` decimal(8,4) **nullable** — credits-per-rand at the moment of top-up. Captures the rate used so historic entries don't re-derive.
- `Court.SlicePriceCredits` int — replaces `SlicePriceZar`. Whole credits, no fractional pricing.

**Tenant settings:**
- `credits_per_zar_regular` (default 1.6 — i.e., R100 → 160 credits)
- `credits_per_zar_league` (default 2.4 — R100 → 240 credits)

**Top-up flow:**
1. Player clicks Top Up → enters R-amount (must be a multiple of `topup_block_zar`, default R100, ≤ `topup_max_zar_per_member`, default R1000).
2. PayFast hosted checkout completes.
3. Callback writes `LedgerEntry { Type: TopUp, AmountCredits: zar * rate, ZarPaid: zar, ConversionRate: rate }`.

**Display:** balance shown in credits (not rand) on the wallet UI. Rand only appears on top-up screens and admin reports.

### 2. Charge at booking — ⚠️ a deviation from A.9

**This section described the opposite until 2026-08-23.** The blueprint asks for the debit
at lights-on; the founder's decision is to take it at booking. What follows is what the code
now does. The reasoning, and what the committee is being asked to approve, is in
[D-1](#d-1--the-debit-happens-at-booking-not-at-lights-on).

**State machine:**
- `BookingStatus.Booked` — slot reserved **and charged**; `ChargedAt` stamped.
- `BookingStatus.Completed` — the slice ended and somebody had checked in.
- `BookingStatus.NoShow` — grace expired without a check-in; the charge is refunded and
  `NoShowPenalty` posted.
- `BookingStatus.Cancelled` — cancelled; refunded per the rules below.

There is no `Active` status. Attendance is the `CheckedInAt` stamp written by
`CourtActivationService`, not a status — a status would have to be maintained by something,
and the only honest witness to attendance is the identification event itself.

**Implications:**
- Cancellation outside the penalty window — full refund; the member is where they started.
- Cancellation inside the penalty window — full refund **and** a `LateCancellationPenalty`
  row. Two rows, not one net row: a netted movement settles to the same balance and cannot
  answer "how much penalty did I pay?", which is precisely what a disputed cancellation asks.
- Cancellation after check-in — **no refund**. This is the one rule that survives unchanged
  from the lights-on model.
- No-show — `CancellationRefund` for the full amount plus `NoShowPenalty`, which is the
  blueprint's own description: the penalty is kept and "the remainder of the fee then gets
  returned to the user that didn't pitch".
- At-court payer override — the booker has *already paid*, so honouring "I'll pay" refunds
  the booker and charges the volunteer. If the volunteer cannot afford it the whole
  reassignment is refused rather than half-applied.

**Walk-ups** are ordinary bookings on this path: created at the court, truncated at whatever
booking comes next, and charged **pro rata** — the first fractional price in the system.

### 3. Member classes drive pricing AND access

> **Superseded by decision D2 (2026-09-23).** Groups replaced the class; the league group carries
> the rate and the peak priority described below. See `feature-spec.md` §1 and
> `memory/decisions-groups.md`. The text below is the original reconciliation, kept for provenance.

`Membership.MemberClass` enum: `Regular`, `LeagueOrSenior`. Admin assigns at approval (or later via member edit).

**Effects:**
- Different top-up rate (above).
- Peak-hours access — Regular members cannot reserve a 16:00–19:00 slot if `slot_starts_at - now > peak_advance_hours_for_regular` (default 1 hour). Inside that window, the slot opens to anyone.
- Tenant settings: `peak_hours = "16:00-19:00"`, `peak_advance_hours_for_regular = 1`.

### 4. At-court payer override

The courtside terminal flow accepts a *second* identification after the booked player has been recognised:

1. Booked player (Alice) is identified at the touchpad.
2. Terminal shows: "Hi Alice — your booking starts now. Tap 'Activate' to charge your account, or another player can identify themselves to pay."
3. If another identified player (Bob) authenticates and presses "I'll pay", Bob's account is debited instead. Booking row stores `booked_by_user_id = Alice`, `paid_by_user_id = Bob`. Both names are audit-logged.
4. Lights come on either way.

This handles guest play, doubles, league-night billing splits, etc.

## Smaller deltas

- **Slice default 15 min** at the Crusaders tenant (configurable).
- **Top-up presets:** R100, R200, R500, R1000 (custom amount must still be a multiple of R100, ≤ R1000 for members).
- **Identification triple-stack:** the court-side terminal accepts (a) biometric (existing), (b) personal code / PIN (entered on the pad), (c) phone-displayed time-based code (TOTP-style, generated by the player's app and shown for a few seconds — pad camera or admin reads it). Implementation note: PIN is the cheapest add — generate at registration, change in profile. QR code is the second-easiest — the player's app shows a signed short-lived QR; the courtside terminal scans it via webcam. Face recognition is deferred until vendor SDK lands.
- **Reports — monthly preset:** add "This month" / "Last month" buttons to the date picker on `/reports`.
- **Member-spend drill-down:** new admin page `/admin/members/{id}/spend` that filters the wallet ledger to that member with monthly buckets.
- **2-year retention worker:** nightly job that anonymises bookings older than `retention_years` (default 2) — clear `user_id` to a sentinel "former-member" UUID, keep aggregate counts for analytics.

## Deviations needing committee sign-off

The blueprint is the customer's word. Where the build departs from it, that departure is
recorded here rather than absorbed silently, and it is **not settled until the committee
says so**.

### D-1 — the debit happens at booking, not at lights-on

**Blueprint A.9:** the member's account is debited "on putting lights on".
**Built:** the debit is posted when the booking is created.
**Decided by:** the founder, 2026-08-22. **Status: awaiting committee sign-off.**

*Why it was changed.* Under charge-on-lights-on a booking holds a court while taking
nothing, so the failure mode is a member who books four peak slots, turns up to one, and has
had four courts out of circulation at no cost. It also splits the money story across two
events that can disagree: the code shipped with a grace window that meant a member could be
inside the activation window and already swept as a no-show, unpaid, with the lights on.

*What it costs.* A member who books and cancels in good time sees two ledger rows — a charge
and a refund — where the blueprint promised none. Their balance is unchanged, but their
statement is busier. That is a real difference to what the club was told, and it is the
thing to put to the committee.

*What is unaffected.* No refund once the lights have been on. The 30% / 5-minute / 15-minute
penalty economics. Who pays under the at-court override. The no-show outcome — refund less
penalty — is the same either way.

*If the committee says no*, the reversal is `BookingService.CreateAsync` and
`CancelAsync` plus the tests that pin them; the ledger types, the activation path and the
court box are all indifferent to which end the debit is taken from.

### D-2 — firmware is signed with RSA-2048, not Ed25519

> **Moot since device contract v2, and again since 2026-11-14:** the boards have no remote
> firmware update at all ([`device-api.md`](device-api.md) §7), so nothing is signed. Kept as
> the record of why the blueprint's Ed25519 line was never built.

**Planned:** Ed25519 signatures on OTA images.
**Built:** RSA-2048/SHA-256, via the ESP8266 Arduino core's supported signed-update path.
**Decided by:** implementation constraint, 2026-08-23. **Not a product decision** — recorded
here so nobody reads the plan later and assumes it was done.

The reasoning behind "Ed25519, not HMAC" was that an HMAC keyed with the device key would let
one compromised box forge firmware for the whole fleet — the signing key must be one no box
holds. **That property is unchanged.** The signing key is asymmetric and lives only where
releases are built, so a stolen board yields nothing that can sign firmware for any other.

What differs is the algorithm. BearSSL — the TLS stack already linked into the image — has no
Ed25519, and the alternative was vendoring a curve implementation into a court-lighting
controller. A few hundred extra bytes per image is the better trade.

**There is also no true rollback**, and that is worth stating plainly: a 4M ESP carrying a
1 MB sketch and 2 MB of LittleFS has no second OTA slot, and the filesystem is not optional
because it holds the device credential. What the boot guard does instead is stop a bad build
being installed twice — which is the failure that takes out a club, since every box
heartbeats against the same manifest and would otherwise reflash in a loop, all at once. A
box that will not boot at all still needs a USB cable.

### D-3 — minutes packages replace credits, the R100 block and the R1000 cap

**Blueprint A.8:** a top-up converts rand to credits at a class rate — R100 → 160 credits
(Regular) or 240 credits (League/65+). **Blueprint A.3:** top-ups in R100 blocks, at most R1000
for a member, admin unlimited.
**Built (P13):** the ledger unit is **whole minutes**, and a booking costs exactly its own
length. A member buys a **package** of minutes the club defines (seeded as 1 hour R120, 5 hours
R550, 10 hours R1000); a group may have packages of its own, and a group may carry a
**package discount** (basis points, rand only, the lowest of a member's groups wins — the league
group starts with none). There is **no block and no cap**; the desk sells packages at the counter
and may adjust minutes by hand. The full contract is
[`minutes-and-packages.md`](./minutes-and-packages.md).
**Decided by:** the founder, 2026-10-01. **Status: decided — no committee step**, by the
founder's own answer (contract §11.3); recorded here so nobody reads the blueprint later and
assumes A.3 and A.8 are still in force.

*Why.* A credit at a class rate made every figure a member saw a conversion they had to do in
their head, and a slice price per court and per group made "what does this booking cost" a
lookup. Minutes are what the member buys and what the court delivers: "45 min" means the same
thing on the grid, the receipt and the wallet. The cap protected nothing once purchases are
whole packages the club itself priced, and every abandoned checkout used to count against it.

*What it costs.* The league's advantage changes shape — from more credits per rand to a
discount on the club's packages — and is zero until the club sets one. Money already in a
club's ledger cannot be converted: the migration refuses to run on a database with money
history, so a club resets before go-live (`docs/go-live-checklist.md`).

### Ratified, not open

- **Penalty economics — 30% penalty, 5-minute grace, 15-minute penalty window.** Agreed with
  the founder and **not** a deviation; recorded here so it is not re-litigated as one. The
  numbers are `tenant_settings` keys (`penalty_pct`, `grace_window_minutes`,
  `penalty_window_minutes`), so the club can move them without a deploy.
- **Walk-ups are real bookings**, in the member's name and visible online immediately, rather
  than an anonymous cash sale at the court.

## Open product questions to bring back to the committee

1. **Saved cards / one-tap top-up.** PayFast supports tokenised recurring billing. Yes/no?
2. **What exactly is "league player / over 65's"?** Is over-65 the only senior class, or any senior membership category at the club? Confirm.
3. **Peak-hours definition** — is 16:00–19:00 every weekday, or also weekends? Same rule on Saturday morning?
4. **Per-day cap exceptions** — does the 1-hour cap apply to admin-booked bookings (e.g. league nights)? Likely no but confirm.
5. **At-court payer override** — should the booked player be notified by email when someone else pays for their slot?
6. **Identification methods** — which one is the priority? My recommendation is PIN first (cheapest), then biometric (already wired), then QR; defer face.
7. **Retention** — 2 years is a hard delete or anonymise-and-keep-aggregates? POPI prefers the latter.

## Implementation phasing

This whole block is best treated as one phase — call it **Phase 8 — Client deltas**. Sub-deliverables map cleanly:

- 8.1 Member classes (schema + admin UI to assign).
- 8.2 Credits model (rename + conversion + top-up flow + display).
- 8.3 Charge **at booking** (booking state machine + ledger flow rewrite) — ⚠️ deviates from A.9, see D-1.
- 8.4 Per-day cap + peak-hours rule + admin overrides.
- 8.5 At-court payer override (courtside flow + booking schema field).
- 8.6 Identification PIN + QR (defer face).
- 8.7 Reports — monthly preset + member-spend drill-down.
- 8.8 2-year retention worker.

Each sub-deliverable is mergeable independently. Order suggestion: 8.1 → 8.2 → 8.3 (these three are coupled and rewrite the economics) → 8.4 → 8.7 → 8.5/8.6 → 8.8.
