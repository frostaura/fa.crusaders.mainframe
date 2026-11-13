---
name: crusaders-mainframe-decisions-frontend-member-golive
description: "Member PWA go-live pass (FM-*, BM-*): tenant club identity, doors code out of the entry, toasts leave with the page, guide reads tenant facts, grid floor, wizard rail."
type: decision
last_verified: 2026-11-13
---

# Live decisions — member PWA, go-live pass (lane frontend-member, 2026-11-13)

Founder frame: the last physical flash; v3 LCD landing reads SCAN YOUR QR CODE with every court's
minutes of light, so the member guide says exactly that (`onboardingCopy` box step).

- **The club's name is tenant data** (FM-8): `GET /api/v1/auth/club` → `{slug,name}` (anonymous,
  tenant-scoped prefix; `ClubIdentityResolver`, the emails' source) read once per load and kept
  per origin (`lib/clubIdentity`). Unknown names NOTHING. **Why:** whoami is tenant-exempt and
  cannot name a club to a visitor. Club content (sign-in facts, public landing) is per slug
  (`lib/clubProfiles`, `clubs/<slug>/`); the static shell (index.html, manifest) stays the first
  club's — per-host serving is infra's. Tests prime the seeded club in `test/setup.ts`; e2e
  `serveApi` answers the club route by default.
- **The doors store is an admin-only chunk** (FM-6): the shell's badge subscribes through a dynamic
  import (`subscribeDoorsStore`), the shut banner is lazy. **Why:** it was ~30 kB of the entry and
  the build failed at 503.4 kB. Entry 480.0 kB raw / 151.5 kB gzip -9 after the whole pass.
- **A toast leaves with its page** (BM-14): a route change drops toasts raised >1.5 s before it;
  one raised with the navigation stays. **Trap:** the provider now re-renders per route, so its
  context value is memoised — a fresh `{push}` re-rendered every caller and broke render-count tests.
- **Registration keeps its button on a transient 5xx** (FM-1): only `tenant_not_found` /
  `tenant_unresolved` block (`isConfigurationFault`). Passkey sheet NotAllowed/Abort = cancelled (FM-2).
- **The guide reads the club** (BM-12): slot length via `useSmallestSlot`, contact via
  `useDoorFacts` (one `/me/door` read); unknown claims nothing. **Why:** "fifteen minutes" and a
  promised phone number were false at clubs that set otherwise.
- **Verify-email branches on `approved`** (BM-11) when the API sends it; absent, it claims neither.
- **Grid ceiling has a 416 px comfort floor** (BM-04), capped by the screen between the app bar and
  docked bars; pixels because `schedule-grid-bugs` pins a pixel ceiling (a rem grows with big text).
- **Welcome wizard: a step rail from lg** (BM-07), not a jump list. **Lone-verb docked bars hug
  the verb** (BM-08).
- **Not done, and why:** FM-7 (act() warnings, ~1,430 in a dot-reporter full run). Two global
  remedies were measured and reverted: an `afterEach` settle (no change — the updates land between
  a test's end and its hooks) and next-task stub replies (no change, 3 → 13 failures). The warnings
  are per-file patterns (`vi.waitFor` instead of RTL's, unawaited reads; chart-theme's 813 only
  under full-suite load). The default reporter hides them; run `--reporter=dot` to see them.
