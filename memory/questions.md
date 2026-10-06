---
name: crusaders-mainframe-questions
description: "All founder-owned and none technical: PIN length (a 4-digit collision charges the wrong member), biometric SDK, gate policy, court-box rosters, walk-behind attendance, pricing beyond Crusaders."
type: question
last_verified: 2026-09-11
---

# Open questions

The relay safety question is the one that gates everything and lives in
[`safety-relays.md`](safety-relays.md). Everything below is **founder-owned (Dean)** unless noted,
and none of it is blocked on engineering.

- **PIN policy.** The club's existing codes are four digits with no uniqueness constraint, and
  matching is first-verify-wins with no deterministic ordering. **Once a PIN authorises a debit, a
  collision charges the wrong member.** Six digits with a blocklist, or keep four and accept it?
- **Which biometric vendor SDK?** The abstraction is complete and a null device plus a simulator
  ship with it, so this blocks only the physical install — but no evaluation exists at all.
- **Should a door's rules ever differ per door?** Gates shipped (2026-09-19) with one club-wide
  policy (`active_member` | `booking_window`) and one roster for every door. **`gate_key` IS an
  access-control input** — since D3 a gate with none is pushed an empty roster, so naming a door
  is what starts its offline fallback; what it still does not do is change *which members* a
  named door admits. Time-of-day or member-class rules would be a design change — see
  [`decisions-gate.md`](decisions-gate.md).
- **Should an auto-registered, never-acknowledged COURT BOX also get no roster?** D3 took the
  roster away from an unnamed gate because a key-holder could self-register one and be handed 48
  live booking codes. A `kind`-less heartbeat from an invented MAC still auto-registers a court
  box on the club's first four courts, with no naming step at all, and is answered with up to 16
  — and after the gate shipped, each of those opens every door in the club inside its booking's
  window. The gate's naming step narrowed that surface; it did not close it. Applying the same
  rule to boxes changes the court-box install story and the offline lighting path, which is
  money, so it is the founder's call and not engineering's. Stated in `docs/specs/door-gate.md`
  §4 and §10a.
- **Is six hours the right ceiling for a cut-off door?** A board that cannot reach the API admits
  rostered bookings until its roster goes stale (`ROSTER_MAX_AGE_MS`), including a member
  suspended or a booking cancelled since the last push. A policy call, not a technical one.
- **SaaS pricing from tenant #2 onward.** Crusaders is free; nothing else is decided.
- **Crusaders' existing member-data migration** — to be settled with the committee.
- **Should a partner who walks in behind a scanning player count as attended?** (play.md §14 Q4.)
  Today yes — the founder's default since R2, kept in R19 — but only behind a PLAYER's scan; a
  pay-for payer's scan counts for nobody ([`decisions-attendance-r19.md`](decisions-attendance-r19.md)).
  "Own seat scan only" is the stricter reading; it changes stats, streaks and badges.
- **Why does a private repo ship an MIT `LICENSE`?** Confirmed 2026-09-16: `LICENSE` is MIT and
  `README.md` says so, while this repo is private by the 2026-07-24 default
  ([`decisions.md`](decisions.md)). Not a contradiction under an opt-in OSS posture, but licensing
  is **parent-controlled**, the same shape as the licence question open on `fa.lifeos`, and nobody
  has decided it here. Confirm MIT or replace it before any customer or second tenant sees the repo.

**Deferred by decision — listed so they are not rediscovered as questions:** recurring bookings
(out of scope for v1) · multi-sport (the column exists, the UI is squash-only) · partner/two-player
booking (v1.1) · walk-ins and guest passes (an admin books under a per-tenant guest address) · PWA
push (email carries the load) · a native wrapper (PWA only) · mandatory backup fingers (recommended,
not enforced) · per-tenant custom domain (schema supports it, UI is v1.1).
