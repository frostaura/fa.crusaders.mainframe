---
name: system-blueprint artifact
description: One-page interactive system blueprint (HTML) — where it lives and how to update it
type: reference
last_verified: 2026-08-24
---
`docs/system-blueprint.html` is a self-contained interactive one-page design of the entire system — topology, GPIO/wiring, DIP modes, firmware split, serial protocol v2 (with a live frame builder), discovery/claiming, webhooks + SSRF guard, backend invariants, ERD, PayFast, deploy chain, and the risk watch list. Generated 2026-08-24 from `docs/specs/*`, `src/iot/README.md` and the memory store; reflects charge-at-booking + PayFast (the 2026-08-22 decisions), and treats `docs/specs/lights-controller.md` as superseded.

Hosted copy (private, shareable): https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4

How to apply: when specs or decisions change (relay/contactor answer, committee sign-off, DIP first-flash finding), regenerate or edit the HTML and republish to the same artifact URL so the link stays stable.
