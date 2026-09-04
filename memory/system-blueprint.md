---
name: system-blueprint artifact
description: One-page interactive system blueprint (HTML) — where it lives and how to update it
type: reference
last_verified: 2026-09-04
---
`docs/system-blueprint.html` is a self-contained interactive one-page design of the entire system — topology, GPIO/wiring, DIP modes, firmware split, serial protocol v2 (with a live frame builder), discovery/claiming, the device API surface, webhooks + SSRF guard, backend invariants, ERD, PayFast, deploy chain (incl. the `iot-sign` → `/firmware/` OTA release half), the risk watch list and a fix-programme panel. Generated 2026-08-24 from `docs/specs/*`, `src/iot/README.md` and the memory store; **regenerated 2026-09-04** against the `claude/e2e-fix-programme` branch — sources were the 2026-08-24 review §1–2, the branch's commit messages, `src/iot/README.md`, the `lib/bridgelogic` headers, the device endpoint / domain / service doc comments, `http/cases.json`, `ci.yml`, the go-live checklist and `memory/watch.md` + `memory/decisions.md`. Reflects charge-at-booking + PayFast (the 2026-08-22 decisions), online-first activation with heartbeat roster fallback, 12-char access codes (JWT QR retired), four-court devices, and treats `docs/specs/lights-controller.md` as superseded. Includes the C6-residual (late activation reverses a settled no-show, commits `04f1198` + `8b65c05`), which landed mid-regeneration and was re-verified against `git log` before the page was finalised. The Google Fonts `<link>` was removed at regeneration so the page opens no external resource; fonts fall back to the system stacks.

Hosted copy (private, shareable): https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4

How to apply: when specs or decisions change (relay/contactor answer, committee sign-off, DIP first-flash finding), regenerate or edit the HTML and republish to the same artifact URL so the link stays stable.
