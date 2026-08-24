---
name: crusaders-mainframe-questions
description: "SAFETY: do the relays switch a contactor or the lighting load directly? Also: PIN length, gate policy vocabulary, revoked-card window, biometric vendor SDK, SaaS pricing, go-live date"
type: question
last_verified: 2026-08-24
---

# Open questions

- **SAFETY — do the court relays switch a contactor coil, or the lighting load directly?** The fitted module is rated 10A/250VAC, which is plausible for one modern LED bank and inadequate for older metal-halide. If it is direct, that needs a qualified electrician before anything ships. **No software decision changes this, and it gates go-live.** Owner: Dean.
- **PIN policy.** The club's existing codes are 4 digits with no uniqueness constraint, and matching is first-verify-wins with no deterministic ordering. Once a PIN authorises a debit, a collision charges the wrong member. Six digits with a blocklist, or keep four and accept it? Owner: Dean.
- **Gate policy vocabulary.** "Per-gate and admin-configurable" settles the shape but not the predicates — active membership, time of day, member class, a booking within N minutes? Needed before gates are built. Owner: Dean.
- **How long may a revoked card still open a gate**, given devices cache and may be offline? A policy call, not a technical one. Owner: Dean.
- ~~**Is the fitted LCD really the 20×4**, or was that a bench substitute?~~ Resolved 2026-08-24: build photo IMG_1161 confirms a 2004A (20×4). Firmware drives it as 16×2 by decision.
- ~~**The first ESP8266 flash may need an external serial adapter.**~~ Resolved 2026-08-24: the canonical wiring sheet documents the ESP-upload position — DIP 5, 6, 7 ON, others OFF — differing from ESP run/monitor only in DIP 7 (flash-mode). No adapter, ever.

- **Which biometric vendor SDK?** The abstraction is complete; the driver decision is the blocker and no evaluation doc exists. Owner: Dean.
- ~~**Arduino fail-safe on network loss.**~~ Resolved by design 2026-08-22: the Mega holds an independent per-relay auto-off timer, so existing sessions run to completion and nothing strands a lit court — fail-safe A, with the existing buttons serving as the physical override C. No new wiring.
- **SaaS pricing for tenant #2 onwards.** Free for Crusaders; everything else TBD. Owner: Dean.
- **Crusaders' existing member-data migration.** TBD with the committee.
- **Crusaders go-live:** does the club go live this quarter, or is the project formally parked with a date? This is the division's leading cash-engine candidate, so the answer is portfolio-relevant. Owner: Dean.
- Deferred by decision, listed so they are not rediscovered as questions: recurring bookings (out of scope v1) · multi-sport (`court_type` column exists, UI is squash-only) · partner/2-player booking (v1.1) · walk-ins and guest passes (admin books under `guests@<tenant>.local`) · PWA push (deferred; email carries the load) · native wrapper (PWA only) · mandatory backup fingers (1 primary + 1 recommended, not enforced) · per-tenant custom domain (schema supports it, UI v1.1) · Docker Hub namespace (assumed `frostaura/crusaders-mainframe-{backend,frontend}`).
