---
name: crusaders-mainframe-questions
description: "Biometric vendor SDK; Arduino fail-safe; SaaS pricing beyond Crusaders; member-data migration; go-live this quarter or park with a date"
type: question
last_verified: 2026-07-24
---

# Open questions

- **Which biometric vendor SDK?** The abstraction is complete; the driver decision is the blocker and no evaluation doc exists. Owner: Dean.
- **Arduino fail-safe on network loss.** Parking-lot decision #1; default A+C (maintain-on plus a physical override pad) is assumed but never confirmed. Owner: Crusaders committee.
- **SaaS pricing for tenant #2 onwards.** Free for Crusaders; everything else TBD. Owner: Dean.
- **Crusaders' existing member-data migration.** TBD with the committee.
- **Crusaders go-live:** does the club go live this quarter, or is the project formally parked with a date? This is the division's leading cash-engine candidate, so the answer is portfolio-relevant. Owner: Dean.
- Deferred by decision, listed so they are not rediscovered as questions: recurring bookings (out of scope v1) · multi-sport (`court_type` column exists, UI is squash-only) · partner/2-player booking (v1.1) · walk-ins and guest passes (admin books under `guests@<tenant>.local`) · PWA push (deferred; email carries the load) · native wrapper (PWA only) · mandatory backup fingers (1 primary + 1 recommended, not enforced) · per-tenant custom domain (schema supports it, UI v1.1) · Docker Hub namespace (assumed `frostaura/crusaders-mainframe-{backend,frontend}`).
