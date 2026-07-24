# Charter — Crusaders Mainframe

## One-line identity
A multi-tenant booking and credit platform for racquet-sport clubs that uses on-court biometric authentication to keep player accountability honest.

## Why it exists
Court-light scheduling at most clubs is a mess of WhatsApp groups, paper sheets, honor-system payments, and chronic no-shows. Players are double-charged or undercharged; courts sit empty during paid slots; admins spend hours reconciling money that never quite balances.

Crusaders Mainframe replaces that with a single source of truth: **a booking is a credit-backed reservation, and a "show-up" is a biometric event at the court itself**. Money flows through a real ledger, no-shows are detected mechanically (not adjudicated socially), and admins get one console to run the entire operation.

The first deployment is at Crusaders Squash Club. The architecture is multi-tenant from the first commit so the same product can serve a second, third, tenth club without rewriting.

## Who it's for
- **Players** — registered, identity-verified members of a club. Need a fast mobile flow: top up, see who's playing when, book a slot, cancel before penalty, pull a receipt. Use passkey/biometric on their phone for sign-in convenience.
- **Admins** — club committee, court manager, treasurer. Need full visibility, the ability to act on any user's behalf, and configurability without engineering involvement (court count, slice length, prices, penalty rules, grace windows, advance-booking horizon).
- **Other clubs (future)** — same product, different `tenant_id`. Their admins onboard themselves through the multi-tenant flow.

## Where it sits in FrostAura
- **Subsidiary:** `Technologies/` — software product, multi-tenant SaaS, recurring-revenue trajectory.
- **Adjacent philanthropic angle:** the former Foundation squash program was killed 2026-07-24; if a philanthropic squash program re-emerges, it starts from a written impact thesis and remains decoupled from this commercial SaaS unless root decides otherwise.
- **Reuses from Technologies:** the `fa.startup` deploy pipeline, JWT+WebAuthn auth pattern.
- **Belongs-in test:** ✅ Generates capital (per-club SaaS or per-booking margin); ✅ Builds reusable capability (multi-tenant booking + biometric peripheral abstraction); ✅ Strengthens FrostAura as an institution (a deployable product with a real customer on day one). Passes the five-point test.
- **Red lines:** ✅ Clears all four. Not predatory finance, not weaponized, not animal-harm, not surveillance/authoritarian (biometric data is local-machine + opt-in for a service the player explicitly signs up for, not population-scale tracking). The biometric abstraction must keep template data on-premises by default — see `docs/specs/biometric-abstraction.md` for the privacy posture.

## What "done" means for v1
- A Crusaders member can register on a phone, get approved, top up via PeachPayments, book a court slot 7 days out, walk to the court, biometric-on the lights, finish their hour, and see the receipt land in their inbox. End-to-end, no admin intervention required.
- A Crusaders admin can configure the club's settings, approve new members, book on behalf of someone, refund a disputed penalty, and pull a monthly transaction report.
- A second club can be onboarded by the platform admin (Dean) in <2 hours and run independently.
- Zero cross-tenant data leakage in security tests.

## Where the boundaries are
- **In scope:** booking, credit ledger, biometric authentication at court, payment top-ups, refunds/penalties, member management, admin overrides, webhooks for events, reports + exports, mobile-first responsive web app.
- **Out of scope (v1):** native iOS/Android apps, league management, ranking/ladder, video review, equipment rental, club-shop e-commerce, in-app messaging between players. Defer until pilot data justifies them.

## Risks worth flagging now
1. **Biometric SDK lock-in.** The abstraction layer is the antidote — design it before picking a vendor. Wrong abstraction = expensive switch later.
2. **PeachPayments integration friction.** ZAR-only, KYC requirements, settlement timing — all need confirmation before claiming "production-ready."
3. **Privacy posture on biometric templates.** Get this right from day one. Templates stay on the on-premises machine; only match results travel over the wire. Cloud-syncing a template to the SaaS backend would change the privacy story materially.
4. **No-show disputes.** A player who claims "I tapped the device but the lights didn't come on" needs an audit trail strong enough to resolve it without a he-said-she-said. Log everything: peripheral request, response code, timestamp, user-id matched, court-id targeted.
5. **Single-tenant pilot becomes second-tenant migration.** Multi-tenant from day one — non-negotiable.
