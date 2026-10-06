---
name: crusaders-mainframe-decisions-demo-mode
description: "Demo mode (2026-10-06): a second tenant per club with a mirror admin, the switch is a session swap, mail/PayFast/webhooks/device keys are off for demo clubs, data drawn relative to now and redrawn after 24 h."
type: decision
last_verified: 2026-10-06
---

# Live decisions — demo mode (2026-10-06, lane demo-mode)

- **A demo club is a second tenant, not a flag on rows.** `tenants.DemoOfTenantId` names its real club (one per club, unique index). The global tenant query filter is the isolation, so a demo session cannot read a real row by construction. Created lazily on the first admin switch.
- **The switch is a session swap.** `POST /api/v1/admin/mode {mode}` answers a sign-in body (+ refresh cookie) for the other club. In demo the admin is a **mirror** user (`users.DemoSourceUserId`): same name, `admin.<id>@demo.crusaders.invalid`, no password, no passkey (WebAuthn register refuses in demo, login refuses a demo credential). The way back leads only to `DemoSourceUserId`, and only while the real account's `SessionEpoch` equals `DemoSourceEpoch` (stamped at each entry) — a sign-out-everywhere also closes the way back. Each crossing and each reset is on the REAL club's change record (`demo.entered/left/reset`).
- **A demo club is never resolved by host or default slug** — only by a token (TenantResolutionMiddleware). A demo token on its own club's host is not a mismatch. A cookie-only refresh adopts the cookie's demo club when it is the demo of the resolved club (`DemoSessions`).
- **Nothing leaves a demo club.** `DemoTenants` keeps the demo ids and an AsyncLocal flag raised by every `TenantContext.Set`; `DemoAwareEmailService` wraps SMTP and drops mail while the flag is up or to any `.invalid` address; the admin outbox finishes demo rows `suppressed`; webhooks return early; the device key resolver ignores demo clubs and the key endpoints answer 409 `demo_mode`; a purchase completes as a simulation (`simulated: true`, no PayFast). **Why both mail checks:** the flag catches a real address typed onto a made-up member; the domain check holds if a path ever sends without a tenant.
- **Data is relative to now and redrawn when stale** (`DemoModeService.StaleAfter` = 24 h; also on Reset). One transaction under `pg_advisory_xact_lock` per demo club: wipe (every TenantId table from the EF model, dependents first, mirrors' users/memberships/preferences/sessions kept, `admin_change_log` never touched) → copy config (settings minus `payfast`/`smtp`, courts, groups+windows, packages) → generate. Badges are awarded after commit by the real `PlayEvaluator`; future league nights by the real `BookingScheduleService`.
- **History is written as rows, not through BookingService** (it refuses the past). The rows follow settlement S1–S5, share pairs `share:{seat}:{seq}:out|in`, purchases with their lock; money is replayed in time order with a purchase inserted before any debit that would go negative. `DemoDataTests` pins the reconciliation.
- **Trap:** the generator saves with `AutoDetectChangesEnabled = false` and seats in their own save — `PlayStaging` reads the tracker once per seat, and with change detection on, a 3 000-booking save ran for over ten minutes.
- **Boards in a demo look alive** because `DemoPulseWorker` stamps `LastSeenAt` on demo boards every minute; nothing else does.
