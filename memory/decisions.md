---
name: crusaders-mainframe-decisions
description: "Product and economics: blueprint Rev 2 is the customer's word and outranks internal specs; credits are the unit of account; charge AT BOOKING supersedes charge-on-lights-on and still needs committee sign-off; PayFast replaced Peach."
type: decision
last_verified: 2026-09-11
---

# Live decisions — product and economics

Blueprint **Rev 2**, received 2026-05-09 from the Crusaders committee and filed at
`docs/specs/client-blueprints/Crusaders-Blueprint-2026-05-Rev2.md` (plus the verbatim `.xlsx`), is
the current economics and supersedes anything older. **It is the customer's own word and outranks
internal specs on economics** — a conflict is resolved in the blueprint's favour or escalated, never
decided in the repo. Line-by-line reconciliation lives in `docs/specs/client-blueprint-deltas.md`.

- **Credits are the unit of account, not rand.** R100 buys **160 credits (Regular)** or **240
  (League or 65+)**. *Why:* the club wanted class-based value without class-based pricing visible on
  the court. ZAR survives only on `PendingTopup` for reconciliation.
- **Two member classes**, `Regular` and `LeagueOrSenior`, assigned by an admin at approval.
- **Charge at booking, not at lights-on.** A booking debits the full slot cost immediately; a
  no-show keeps a configurable penalty and refunds the rest. *Why:* it collapses hold-then-charge
  into one movement and makes a lost-slot race unable to leave a member paying for a court they
  never got. **This deliberately contradicts blueprint A.9**, is recorded as deviation **D-1**, and
  **is not the repo's decision to close** — the committee must sign it off before go-live
  ([`watch.md`](watch.md)). The ledger consequences are in
  [`decisions-settlement.md`](decisions-settlement.md).
- **15-minute slices** (Crusaders moved 30 → 15) · **2-week booking horizon** · **1 hour per member
  per day**, relaxed same-day when courts are free · **top-ups in R100 blocks, R1000 cap per
  member**, admin credit unlimited · **unfunded accounts cannot book** (402).
- **Peak-hours league exclusivity 16:00–19:00.** A Regular member takes a peak slot only inside the
  last hour before start and only if still empty; admins bypass.
- **At-court payer override.** Another identified player presses "I'll pay"; the booking carries
  `booked_by_user_id` and `paid_by_user_id`, both audit-logged and emailed.
- **Identification is biometric + PIN + code**, stated goal "do away with cards". Face recognition
  deferred. The token grammar is in [`decisions-device.md`](decisions-device.md).
- **Walk-ups create real bookings.** Buying light time at the pad produces a booking in the buyer's
  name, visible online immediately. *Why:* one money path and one data model rather than two. A
  walk-up is born activated and can never be a no-show; it is truncated at the next booking and
  charged pro rata.
- **PayFast replaced PeachPayments.** The `IPaymentProvider` seam survived; the branding did not.
  PayFast signs MD5 over a PHP-`urlencode`-compatible string (spaces as `+`, uppercase hex) which
  .NET's escaping does not reproduce — budget real time for signature parity.
- **Biometrics are soft on the critical path.** Booking, top-up and cancellation all work without
  them and v1.0 can fall back to an admin "mark as no-show", so the physical install does not gate
  the SaaS launch.
- **Free-tier-first on external data — and only the tzdb half is built.** Confirmed 2026-09-16:
  `TimeZoneInfo.FindSystemTimeZoneById` is real (`Services/BookingService.cs`, `ScheduleService.cs`,
  `Endpoints/ReportingEndpoints.cs`), and SMTP + PayFast are the only paid third parties. The rest of
  `docs/development-plan.md`'s item 5 — libphonenumber, a Gravatar avatar fallback, MX-based email
  validation — is **unbuilt**: no package, no phone field, no MX lookup, and the single `Dns.` call
  in the API is the SSRF guard. `en-ZA` is deliberately *not* used for money; PayFast rejects its
  comma decimal, so signing formats with `InvariantCulture`. The plan is not the build.
- **2-year retention** of usage history via a nightly anonymisation worker.
- **POPI compliance is deliberately out of scope** (founder, 2026-05-06: "forget about legislation
  for now"). A decision, not an oversight — **revisit before any club other than Crusaders
  onboards.**
- **This repo is private**, as the first project under the 2026-07-24 private-by-default rule.
- **Commercial club software and any philanthropic squash programme stay decoupled** unless root
  decides otherwise; the Foundation squash programme was killed 2026-07-24.
- **This repo carries no local `.claude/skills/` and must not reacquire one.** The vendored Gaia
  toolkit was removed 2026-08-21 and that removal is committed here. *Why:* generic procedure
  belongs upstream in a plugin, not forked into a product repo — the evidence that settled it is the
  division's [`vendored-skills-verdict.md`](../../../memory/vendored-skills-verdict.md).
