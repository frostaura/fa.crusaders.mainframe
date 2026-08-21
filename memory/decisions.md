---
name: crusaders-mainframe-decisions
description: "Blueprint Rev 2 economics: credits not rand (160/240 per R100), two member classes, charge-on-lights-on, payer override, POPI deferred, biometrics soft-path"
type: decision
last_verified: 2026-07-24
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
