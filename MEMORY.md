# MEMORY — crusaders.mainframe

- [Current state](memory/state.md) — Private repo created + pushed 2026-08-21 (main tracks origin 0/0); CI runs at last: frontend green, backend red on the 6 known money-bug tests; Phase 8 largely BUILT though the plan says Specified
- [Live decisions](memory/decisions.md) — Blueprint Rev 2 economics: credits not rand (160/240 per R100), two member classes, charge-on-lights-on, payer override, POPI deferred, biometrics soft-path; lint gate kept strict; red tests stay red until credits rename
- [Gotchas](memory/gotchas.md) — MONEY BUG: credits rename half-done — the same column is labelled ZAR and credits; only one migration exists so a deployed DB is stuck; .env holds real SMTP creds; iCloud MSB3021 + vitest localStorage traps with recoveries
- [Open questions](memory/questions.md) — Biometric vendor SDK; Arduino fail-safe; SaaS pricing beyond Crusaders; member-data migration; go-live this quarter or park with a date
- [Watch list](memory/watch.md) — Ordered by risk: finish credits rename + migrations (greens the 6 red CI tests); set the 6 Actions secrets; rewrite the plan's status snapshot; unwaivered frontend deviation; no architecture doc
- [Success metrics (working set)](memory/success-metrics.md) — Launch bar: 100% bookings in-system within 60 days; ≥95% lights-on match; ≥70% members positive credit; 2nd club onboarded <2h; ≥99.5% club-hours uptime
