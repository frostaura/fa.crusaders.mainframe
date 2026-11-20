---
name: technologies-crusaders-squash-control-system-decisions
description: "Product and economics: blueprint Rev 2 is the customer's word on economics; whole minutes replaced credits (P13); charge AT BOOKING still needs committee sign-off; PayFast replaced Peach."
type: decision
last_verified: 2026-11-20
---

# Live decisions — product and economics

Blueprint **Rev 2**, received 2026-05-09 from the Crusaders committee and filed at
`docs/specs/client-blueprints/Crusaders-Blueprint-2026-05-Rev2.md` (plus the verbatim `.xlsx`), is the current
economics and supersedes anything older. **It is the customer's own word and outranks internal specs on economics** —
a conflict is resolved in the blueprint's favour or escalated, never decided in the repo. Line-by-line reconciliation
lives in `docs/specs/client-blueprint-deltas.md`.

- **Whole minutes are the unit of account, not rand — and no longer credits** (P13, 2026-10-01, founder; contract
  `docs/specs/minutes-and-packages.md`). A booking costs exactly its playing minutes; members buy admin-defined minute
  packages, with group discounts in rand ([`decisions-topups.md`](decisions-topups.md),
  [`decisions-groups.md`](decisions-groups.md)). This REPLACES Rev 2's credits (R100 → 160 regular / 240 league),
  which priced value by class; the club was pre-launch, so no balance was converted. Rand lives only where money
  changed hands.
- **No member classes since D2 (2026-09-23)** — groups carry a package discount and peak priority, never a price or a
  rate (P13): [`decisions-groups.md`](decisions-groups.md).
- **Charge at booking, not at lights-on.** A booking debits the full slot cost immediately; a no-show keeps a
  configurable penalty and refunds the rest. *Why:* it collapses hold-then-charge into one movement and makes a
  lost-slot race unable to leave a member paying for a court they never got. **This deliberately contradicts blueprint
  A.9**, is recorded as deviation **D-1**, and **is not the repo's decision to close** — the committee must sign it
  off before go-live ([`watch.md`](watch.md)). The ledger consequences are in
  [`decisions-settlement.md`](decisions-settlement.md).
- **15-minute slices** (Crusaders moved 30 → 15) · **2-week booking horizon** · **1 hour per member per day**, relaxed
  same-day when courts are free · **unfunded accounts cannot book** (402). The R100 blocks and R1000 cap per member
  went with P13: packages have no cap (decisions-topups).
- **Peak-hours exclusivity 16:00–19:00.** A member without peak priority takes a peak slot only inside the last hour
  before start and only if still empty; admins bypass.
- **At-court payer override (D10 pay-for).** Another identified player pays for the court; the booking carries
  `booked_by_user_id` and `paid_by_user_id`, both audit-logged and emailed. **Unreachable from the panel since bridge
  2.3.0** — a lit-court press after a scan is an EXTEND — and out of the image at 3.1.0; the server route `/pay-for`
  stays, so it can return with a bridge cable flash ([`decisions-court-box.md`](decisions-court-box.md)).
- **Identification is biometric + PIN + code**, stated goal "do away with cards". Face recognition deferred. The token
  grammar is in [`decisions-device.md`](decisions-device.md).
- **Walk-ups create real bookings.** Buying light time at the pad produces a booking in the buyer's name, visible
  online immediately. *Why:* one money path and one data model rather than two. A walk-up is born activated and can
  never be a no-show; it is truncated at the next booking and charged pro rata.
- **PayFast replaced PeachPayments.** The `IPaymentProvider` seam survived; the branding did not. PayFast signs MD5
  over a PHP-`urlencode`-compatible string (spaces as `+`, uppercase hex) which .NET's escaping does not reproduce —
  budget real time for signature parity.
- **Biometrics are soft on the critical path.** Booking, top-up and cancellation all work without them and v1.0 can
  fall back to an admin "mark as no-show", so the physical install does not gate the SaaS launch.
- **Free-tier-first on external data — and only the tzdb half is built.** The IANA tzdb through `TimeZoneInfo` is real
  — one zone rule, `Services/ClubClock.cs:54` (`TryFindSystemTimeZoneById`; `BookingService.ResolveTz` delegates to
  it), with `DoorClock`, `MemberCodeMath`, the device and config endpoints and `TenantCli` alike and one bare
  `FindSystemTimeZoneById` left in `Endpoints/ReportingEndpoints.cs:436` — and SMTP + PayFast are the only paid third
  parties. The rest of `docs/development-plan.md`'s item 5 — libphonenumber, a Gravatar avatar fallback, MX-based
  email validation — is **unbuilt**: no package, no phone field, no MX lookup, and the single `Dns.` call in the API
  is the SSRF guard. The plan is not the build. (`InvariantCulture` for money, never `en-ZA`: CLAUDE.md.)
- **2-year retention** of usage history via a nightly anonymisation worker.
- **POPI compliance is deliberately out of scope** (founder, 2026-05-06: "forget about legislation for now"). A
  decision, not an oversight — **revisit before any club other than Crusaders onboards.**
- **Public, by founder decision (2026-11-20)**: all nine `frostaura` repos were made public that night, each history
  scanned for credentials first. It had been private under the 2026-07-24 default. Re-read it with `gh repo view`
  (CLAUDE.md); the licence question is open ([`questions.md`](questions.md)).
- **Commercial club software and any philanthropic squash programme stay decoupled** unless root decides otherwise;
  the Foundation squash programme was killed 2026-07-24.
- **This repo carries no local `.claude/skills/` and must not reacquire one.** The vendored Gaia toolkit was removed
  2026-08-21 and that removal is committed here. *Why:* generic procedure belongs upstream in a plugin, not forked
  into a product repo — the evidence that settled it is the division's
  [`vendored-skills-verdict.md`](../../../memory/vendored-skills-verdict.md).
