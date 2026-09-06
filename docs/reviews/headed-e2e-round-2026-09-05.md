# Headed-browser adversarial E2E round — 2026-09-05

**Claim under test:** "every member, admin, money and court-box flow works end to end, flawlessly, through the real UI, exactly as a human would use it." Five independent finders were told to refute it. Each drove its own isolated stack (real API from source, real Postgres, the real Mega firmware as the native simulator, the PayFast imposter, Mailhog for every email) through a headed Chromium — clicking and typing like a member or a club admin — and played the ESP bridge with curl against the shared device contract. Nothing ran on real hardware.

**Verdict:** the claim was false. 82 findings reproduced twice each: 2 critical, 21 high, 35 medium, 24 low. The settlement engine, tenant/authorisation boundaries, the device pairing, the serial contract and the responsive layout held up; the failures cluster in screens that were never driven by a person — a top-up form posting a field the API does not read, a forgot-password link with no route behind it, booking rules that answer 500, a webhook log that reads camelCase as PascalCase.

The five full reports (steps, screenshots, API bodies, DB rows, file:line) were session artefacts; this file is the record. The fix disposition per finding is in the last section.

## Method

| Finder | Scope | Findings |
|---|---|---|
| A | Member onboarding and account | 10 |
| B | Booking, schedule, court code and the court box | 16 |
| C | Money — top-ups, charges, ledger, reports | 20 |
| D | The admin's day — members, devices, settings, webhooks | 14 |
| E | Cross-cutting — resilience, production build, security, diagrams | 22 |

Stack per finder: API on its own port with the Development seeder (tenant `crusaders`, admin, four courts, five sample members), Vite dev server proxying `/api`, a fresh database per finder on the shared Postgres container, the Mega simulator on its own TCP port with a command file for `scan`/`btn`, the shared PayFast imposter on :4545 and Mailhog on :8025. The launcher and briefs lived in the session scratchpad; the recipe worth keeping is in `test/e2e-device/README.md` and `memory/gotchas.md`.

Two method lessons, recorded in the memory store: the Playwright MCP plugin is one browser shared by every agent in a session, so each finder fell back to its own headed Chromium; and a launcher that backgrounds servers must detach them from stdin or the caller never returns.

## Findings, by severity

| # | Finder | Sev | Title |
|---|---|---|---|
| C-F1 | C | critical | No member can top up: the Top-up form posts a field name the API does not read |
| C-F2 | C | critical | Even with F1 fixed the payment cannot start: the redirect carries no signed form |
| A-F1 | A | high | "Forgot password?" is a dead link — no self-service password reset exists anywhere in the UI |
| A-F2 | A | high | A signed-in member can never change their password — the admin-issued temporary password is permanent |
| A-F3 | A | high | An approved member whose email was never verified is permanently locked out of password sign-in and told the wrong reason — while the welcome magic link lets them in anyway |
| A-F4 | A | high | Registering with a membership number that is already taken returns HTTP 500 with a full exception dump, and the screen says "Registration failed. Try again." |
| B-F1 | B | high | The two headline booking rules answer HTTP 500; the member is told only "Booking failed." |
| B-F2 | B | high | The grid paints only a booking's *first* slice, so occupied court-time shows as "Available" — and a live walk-up is invisible entirely |
| B-F3 | B | high | Operating hours are never enforced — a member books, and is charged for, court time while the club is shut |
| B-F4 | B | high | Cancelling a court whose lights are already on takes the whole price in silence, and the app says "refund pending" |
| C-F3 | C | high | A top-up is converted at the rate in force when the ITN lands, not the rate quoted at checkout |
| C-F4 | C | high | Every money email labels credits as rand |
| C-F5 | C | high | A cancellation penalty is taken with no warning anywhere on screen |
| C-F6 | C | high | The Top-up screen hardcodes every configurable money number, so it lies as soon as an admin changes one |
| C-F7 | C | high | "Download wallet CSV" downloads nothing, silently |
| D-F1 | D | high | Member class is invisible and unassignable, so the league/senior rate and peak-hour rule can never be applied |
| D-F2 | D | high | The webhook delivery log is entirely broken — DTO is PascalCase, API answers camelCase |
| D-F3 | D | high | "Forgot password?" is a dead link — it dumps the user on the marketing home page |
| D-F4 | D | high | Duplicate membership number returns an unhandled 500, and the applicant is told to "Try again" |
| E-F01 | E | high | Password reset does not exist in the SPA — the reset email is a dead link |
| E-F02 | E | high | One 502 from the backend permanently signs every user out (a deploy = mass logout) |
| E-F03 | E | high | Admin "Adjust credit" double-click posts the adjustment twice — money is wrong |
| E-F04 | E | high | No request timeout anywhere: a stalled backend leaves the Book button spinning forever |
| A-F5 | A | medium | Every 400 from `/register` is reported as "password must be at least 8 characters", including when the password is fine |
| A-F6 | A | medium | When the session token goes away mid-use, the app keeps pretending you are signed in and blames your connection |
| A-F7 | A | medium | No admin is notified when someone registers |
| A-F8 | A | medium | A deep link is lost across sign-in — you always land on `/schedule` |
| B-F5 | B | medium | Cancellation gives no penalty warning — 15.00 cr is taken with nothing on screen about it |
| B-F6 | B | medium | The booking confirmation is not the specified modal, and it silently disarms after 3 seconds |
| B-F7 | B | medium | The member's ledger describes every booking at the wrong wall-clock time (UTC, not the tenant's timezone) |
| B-F8 | B | medium | Nothing anywhere in the product shows whether a member checked in |
| B-F9 | B | medium | The member's Reports page cannot be reconciled to their own balance, and omits half of what `reporting.md` promises |
| B-F11 | B | medium | The admin schedule offers no admin action at all |
| B-F12 | B | medium | `make test-e2e-device` — the repo's "one command, one verdict" hardware-free proof — cannot run: `xor_checksum` is undefined |
| C-F8 | C | medium | After confirming anything, the button is stuck on "Working..." until a full browser reload |
| C-F9 | C | medium | `/wallet` shows two different balances at once and has no way to refresh |
| C-F10 | C | medium | Every ledger comment prints the booking time in UTC, not the club's timezone |
| C-F11 | C | medium | `/reports` contradicts itself and the ledger |
| C-F12 | C | medium | A large credit adjustment 500s instead of being validated |
| C-F13 | C | medium | The top-up status page shows the member a raw internal error string, and calls a cancelled payment "Failed" |
| C-F14 | C | medium | No email is sent for a top-up or for a credit adjustment |
| D-F5 | D | medium | A box with fewer courts than the club default can never be returned to the club default |
| D-F6 | D | medium | `grace_window_minutes` and `penalty_window_minutes` are the only two settings with no server-side range check — and they are the two that take money off a member |
| D-F7 | D | medium | Nine of the fifteen spec'd webhook event classes do not exist — including the two the spec names inside the registration flow |
| D-F8 | D | medium | The webhook create form throws away the API's reason for a refusal |
| D-F9 | D | medium | An admin-issued temporary password is neither single-use nor forced-reset |
| D-F10 | D | medium | Suspend/reactivate does not exist, but the console offers a "Suspended" filter and the spec promises the operation |
| D-F11 | D | medium | `tenant_settings.timezone` drives the whole booking grid but cannot be set from anywhere in the product |
| D-F12 | D | medium | Uploaded member photos are broken images under the dev server — `/uploads` is proxied by nginx but not by Vite |
| E-F05 | E | medium | The live balance freezes for the rest of the session once the JWT rotates |
| E-F06 | E | medium | Spec §12 promises an installable, offline-capable PWA; the production build ships neither |
| E-F07 | E | medium | Two required emails from spec §11 are not sent / not complete |
| E-F08 | E | medium | The muted text token fails the WCAG AA floor the design system commits to — including the booking grid's time labels |
| E-F09 | E | medium | `docs/system-blueprint.html` describes a device security model that no longer exists |
| E-F10 | E | medium | A rate-limited member is told "Sign in failed." — the API's actual message is thrown away |
| E-F11 | E | medium | Sign out is client-side only — the token stays valid after you leave |
| E-F12 | E | medium | The credit-conversion rate field cannot express the club's own rate; its spinner shifts it by 0.01 |
| E-F13 | E | medium | Member photos never render under the dev server — `/uploads` is not proxied by Vite |
| A-F9 | A | low | Profile name: the server-side minimum is never explained, and Save is enabled for a name the server will refuse |
| A-F10 | A | low | Every failed registration leaves an orphaned photo on disk, uploaded anonymously |
| B-F10 | B | low | An expired session answers `400 tenant_unresolved`, and the schedule then tells the member "That slot is in the past." |
| B-F13 | B | low | `LightsCueWorker` loses a tick to an optimistic-concurrency crash on start-up |
| B-F14 | B | low | Decimal separators disagree inside one ledger row |
| B-F15 | B | low | A member cannot look at yesterday |
| B-F16 | B | low | The documented `SLOT ENDED` screen is unreachable more than ~15 seconds after a slot ends |
| C-F15 | C | low | An invalid top-up amount gives no reason, and a trailing-garbage amount is accepted |
| C-F16 | C | low | A sub-cent adjustment creates half a cent and the API echoes a number it did not store |
| C-F17 | C | low | Clearing a date on `/admin/ledger` sends a malformed range and leaves stale rows on screen |
| C-F18 | C | low | The wallet ledger opens with Amount and Comment off-screen at 375 px |
| C-F19 | C | low | A negative adjustment reads as if the admin personally took the money |
| C-F20 | C | low | Console noise and a mixed-unit "Slices" column on `/reports` |
| D-F13 | D | low | The Settings hint about offline detection is wrong for any heartbeat under 60 s |
| D-F14 | D | low | The club-default button map lives on the Devices page, not the Settings page the spec names |
| E-F14 | E | low | The wallet SSE stream puts the full access JWT in the URL, where every proxy logs it |
| E-F15 | E | low | `tenant_settings.UpdatedAt` never advances |
| E-F16 | E | low | There is no 404 page — every unknown URL silently becomes the home page |
| E-F17 | E | low | The gateway proxies `/graphql` to a backend path that does not exist |
| E-F18 | E | low | On a phone, the wallet ledger's Amount column is off-screen with no scroll affordance |
| E-F19 | E | low | The Reports page logs 16 recharts warnings on every load |
| E-F20 | E | low | An expired session drops you on the login screen with no explanation |
| E-F21 | E | low | Booking-grid slot buttons have no accessible name beyond "Available" |
| E-F22 | E | low | The compose file most people will reach for defaults to `Development`, which turns on an anonymous admin-token endpoint |

## What passed

Each finder closed with a list of flows it proved by driving them. In aggregate: registration → verification email → approval → welcome link → sign-in; login negatives without account enumeration; session persistence, auto-refresh of the access token, expiry handling and logout; passkeys end to end through a virtual authenticator; every guarded route as anonymous, member and admin; keyboard-only login → book → sign out; booking survives refresh; timezone rendering consistent across grid, court-code page, email and toast (Africa/Johannesburg); 375 px layouts without page-level overflow on every screen; the production build served behind an `/uploads`-proxying server (dev-login absent, photos load); browser back/forward through a flow; admin members search/filter/sort/approve/reject-with-reason/reset-password/adjust-credit/biometric enrol-unenrol; device API key masked/reveal/copy/regenerate with old-key 401 and new-key 200; a box auto-registering on first heartbeat, court-list shrink trimming the button map, override validation, minimal PATCH, online→offline→online, delete-then-re-register; eighteen settings refused server-side with named errors and a changed setting reaching both the box and the member; SSRF guard on loopback, RFC1918, link-local, non-http schemes; webhook create, template substitution, retry with backoff, delete; the whole settlement engine — signed ITN credits once, replay idempotent, tampered 401, amount mismatch 400, two in-flight top-ups independent, cancel outside window free with no zero row, inside window two rows never netted at exactly P × pct, price locked at booking, admin adjustments honour the I3/I4 invariants, walk-up charged at the new price and its replay charged nothing; authorisation under direct API attack (member JWT on admin routes 403, device key on member routes anonymous, member JWT on device routes 401, CORS closed, rate limiter 429 with Retry-After); `docs/court-lights-flows.html` matching the product on every flow reached.

## Not covered by this round

Real PayFast (imposter only); real hardware (the Mega is the real firmware on a socket, the ESP is played by curl); webhook auto-disable after six failures (the sixth is ~15 h out); a receiver on the LAN allow-list (no admin surface for the list); multi-template biometric enrolment; platform-admin operations; two-tenant isolation through the UI (one tenant seeded); production-mode 500 bodies; photo-upload size limits through nginx.

## Fix disposition — round 1

Five fixer agents closed the 82 findings in five scopes, each followed by an independent refuter
told to disprove the fixer's own report. 48 confirmed fixed on the first pass; the rest came back
`partially-fixed`, `regression-introduced` or `spec-retreat` and went into round 2.

Three results are worth keeping for their method rather than their subject:

- **The service-worker leak was reproduced, not argued.** A refuter served the production build
  with the shipped cache headers, registered the worker in a real Chromium, fetched `/wallet` as
  one member and then as another, and got the first member's balance both times. It then swapped
  in the fix and watched the new worker purge the poisoned caches.
- **Two fixers wrote false sentences into the spec** and both were caught by refuters running
  something rather than reading: that `peripheral.unhealthy` needed a liveness signal the hardware
  lacks (the box pushes a heartbeat, and the API already computes an offline threshold from it),
  and that a service worker cannot be registered in this repo's automation (it can; the refuter
  did it on the first attempt). A false claim in a spec is worse than an open finding, because the
  next agent believes it.
- **A duplicate the merge created.** Two fixers independently closed "no admin is notified when
  someone registers", from different files, and the merge kept both, so every application sent the
  club's desk two emails. The old assertion used `Contains`, which passes on duplicates; it asserts
  exactly one now.

## Round 2 — 2026-09-06

Five fresh finders drove the rebuilt product, weighted toward what a person notices and a suite
cannot: the state of a control AFTER a successful action, measured timings on anything a member
waits for, hover/focus/active affordance on every clickable surface, both themes at 375/768/1440,
and regressions in the round-1 work.

**64 findings: 0 critical, 9 high, 26 medium, 29 low** — against round 1's 2 critical and 21 high.
Five of the nine highs were regressions the round-1 fixes had introduced, which is the argument for
running the loop again rather than stopping at one pass.

The highs: the wallet's live balance stream stopping ~25 s after page load (found independently by
three finders); a completed payment whose status page says "waiting for confirmation" for ever; the
webhook form arriving pre-filled with a third-party URL, so two clicks publish member data off-site;
a club unable to change its opening hours, because round 1 made hours enforceable without giving
anyone an editor; the app framable by any origin (no `X-Frame-Options`, no CSP `frame-ancestors`);
sign-out in one tab leaving the others signed-in and blaming the network; and a refused booking
leaving the dialog open with its only explanation in a toast rendered behind the modal.

Both symptoms the founder reported personally were hunted specifically and did not return: four
consecutive bookings with no reload, confirm-to-dialog-closed in 68–98 ms, and on a throttled
network (1.5 s latency, 50 kbps) the button read "Booking…" throughout and was back at rest 1.73 s
after a refused booking. Server-side the booking path is 40–80 ms; everything else a member waits
for is one round-trip.

Six fixers closed them, each with its own refuter: **48 confirmed-fixed, 9 partially-fixed, 2
unverifiable** (both founder symptoms, out of that verifier's scope and settled by finder G's own
measurements above).

### What the merges cost, and the process lesson

Six branches editing the same screens produced conflicts where both sides were right about
different things — a duplicated guard TypeScript caught, two versions of the outage-screen retry
button (one carrying a `mounted` ref a refuter had already proved leaves the button dead for the
life of the tab under StrictMode), and two parallel redesigns of the admin members table that
shipped **contradictory tests about the same element**: one asserting the action icons wrap, the
other asserting they do not. Both were written from real findings. Scoping two fixers onto
overlapping screens cost that work twice; round 3's scopes are disjoint by file, not by theme.
