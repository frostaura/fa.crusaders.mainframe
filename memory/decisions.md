---
name: crusaders-mainframe-decisions
description: "Court-hardware programme agreed 2026-08-22: charge AT BOOKING (supersedes charge-on-lights-on), PayFast not Peach, brains on the ESP8266, walk-ups create bookings, gates parked; blueprint Rev 2 economics otherwise stand"
type: decision
last_verified: 2026-08-22
---

# Live decisions

Blueprint **Rev 2** (received 2026-05-09 from the Crusaders committee, filed at `docs/specs/client-blueprints/Crusaders-Blueprint-2026-05-Rev2.md` in both `.md` and `.xlsx`) is the current economics and supersedes anything older.

- **Credits, not rand, are the unit of account.** R100 → **160 credits (Regular)** / **240 credits (League or 65+)**. The club wanted class-based value without class-based pricing on the court.
- **Two member classes:** `Regular` and `LeagueOrSenior`, assigned by an admin at approval time.
- **Charge on lights-on, not on booking.** Booking creates a hold only; the lights-on event posts the debit — cancellation before lights-on then needs no refund at all, removing an entire class of ledger complexity and dispute.
- **15-minute slices** (Crusaders default changed 30 → 15). **2-week booking horizon. 1 hour per member per day**, relaxed same-day if courts are free.
- **Top-ups in R100 blocks, max R1000 per member**; admin credit unlimited.
- **Peak-hours league exclusivity 16:00–19:00** — Regular members take a peak slot only inside the last hour before start, and only if still empty. Admins bypass.
- **At-court payer override** — a different identified player can press "I'll pay"; the booking records `booked_by_user_id` and `paid_by_user_id`, both audit-logged and emailed.
- **Identification triple-stack:** biometric + PIN + QR (60s signed token, courtside webcam scan). Face recognition deferred. Stated goal: "do away with cards."
- **Unfunded accounts cannot book** — 402 InsufficientBalance.
- **2-year retention** of usage history via a nightly anonymisation worker.
- **POPI compliance is deliberately out of scope.** Founder direction, 2026-05-06: "forget about legislation for now." A decision, not an oversight — but revisit before any club other than Crusaders onboards.
- **Biometrics are soft on the critical path.** Booking, top-up and cancellation all work without them; v1.0 can fall back to a manual admin "mark as no-show". The physical install is off the SaaS launch critical path.
- **New repos are private by default** (founder, 2026-07-24) — this was the first under that rule. Created private and pushed 2026-08-21 on the founder's instruction.
- **Lint gate kept strict; loader idiom carries documented per-site disables** (2026-08-21). The 31 react-hooks v7 errors were fixed for real where the rule caught genuine impurity (render-time `Date.now`, refs read in render, sync state init), and the recurring fetch-on-mount loader idiom got `eslint-disable-next-line` with a stated reason at each site rather than downgrading the rule in config. Rationale: a config downgrade would silence the rule for all future code in a money-handling product; per-site disables keep it enforcing while acknowledging the existing house idiom.
- **The 6 red backend tests stay red on purpose** (2026-08-21). 5 BookingTests assert pre-Rev-2 economics and HealthEndpointTests trips EF pending-model-changes — both are the credits-rename + missing-migrations money bug. Editing tests or suppressing the EF validation to green the gate would hide the exact defect the gate exists to catch; they go green when the credits work lands.
- **The Foundation squash program was killed 2026-07-24.** The standing rationale survives: commercial club software and any future philanthropic squash program stay decoupled unless root decides otherwise. Kill record in `Foundation/projects/MEMORY.md`.

## Court-hardware programme (founder, 2026-08-22)

Agreed across a working session with the founder. These supersede earlier entries where they conflict.

- **Charge at booking, not at lights-on.** A booking debits the full slot cost immediately; a no-show keeps a configurable penalty and refunds the remainder. **This directly supersedes the charge-on-lights-on invariant** in `CLAUDE.md`, which forbids exactly this. The invariant is rewritten in the same commit as the code, not before — the codebase must never contradict its own charter. Not yet implemented; the charge still happens at activation.
- **No refund once the lights have been on.** Partial use is not refunded. Note the current cancel path refunds the unused fraction whenever `ChargedAt` is set, and under charge-at-booking that branch becomes the path *every* cancellation takes — it must be rewritten in the same phase.
- **One configurable penalty period** governs both ends: cancel before it, full refund; miss it, no-show and the court is released. Maps onto the existing `penalty_window_minutes` and `penalty_pct`.
- **PayFast replaces PeachPayments.** The `IPaymentProvider` seam survives intact; the branding does not. PayFast signs with MD5 over a PHP-`urlencode`-compatible parameter string — spaces as `+`, uppercase hex — which .NET's escaping does not reproduce. Budget a day for signature parity.
- **The brains move to the ESP8266.** The ATmega2560 cannot be flashed over WiFi (its ESP sits on Serial3, not the Serial0 bootloader port, and no GPIO reaches RESET), and **the wiring cannot change**. So the Mega becomes a thin I/O layer with an independent auto-off timer, and everything volatile lives on the ESP, which OTAs. Rationale: it makes USB-only flashing of the Mega a non-event rather than a recurring trip to the club.
- **The LCD stays 16×2** even though the fitted panel is a 20×4 (silkscreened 2004A). Safety over screen real estate; the geometry is a compile-time constant.
- **Walk-ups create real bookings.** A member buying light time at the terminal produces a booking in their name, visible online immediately — so there is one money path and one data model, not two. A walk-up booking is born activated and can never be a no-show.
- **A walk-up is truncated at the next booking** and charged pro rata. Note this needs new arithmetic: `sliceCount` is an integer and price is a flat multiple of it, so no fractional path exists.
- **Buttons are remappable from the admin panel** — any physical button to any action, including which court it drives. Free, because the Mega already reports raw keypresses and lets the brain decide.
- **Gates are parked.** Hardware undecided, possibly a plain ESP per gate. The device model stays open so they slot in later without redesign.
- **Delivery is one branch, one PR** (`claude/squash-booking-system-design-dt7ja6`, PR #1). Do not split it.
- **Fix everything found, related or not**, with adversarial QA rounds rather than a fixed number of passes.
