---
name: technologies-crusaders-squash-control-system-decisions-frontend-member-screens
description: "Member PWA surfaces: the club's name is tenant data, the guide reads the club's facts, a stalled first read says Still trying, the Wallet card measures spendable against the shortest court, one end time, figures glued at paint."
type: decision
last_verified: 2026-11-20
---

# Live decisions — member screens (identity, guide, wallet card, bookings facts)

Booking grid and sheets: [`decisions-frontend-bookings.md`](decisions-frontend-bookings.md) and
[`decisions-frontend-book-sheets.md`](decisions-frontend-book-sheets.md); offline wording:
[`decisions-frontend-offline-data.md`](decisions-frontend-offline-data.md).

- **The club's name is tenant data** (go-live FM-8): `GET /api/v1/auth/club` → `{slug,name}` (anonymous, tenant-scoped
  prefix; `ClubIdentityResolver`, the emails' source) read once per load and kept per origin (`lib/clubIdentity`); an
  unknown club names NOTHING. *Why:* whoami is tenant-exempt and cannot name a club to a visitor. Club content (sign-in
  facts, public landing) is per slug (`lib/clubProfiles`, `clubs/<slug>/`); the static shell (index.html, manifest)
  stays the first club's — per-host serving needs gateway SSI (owed). Tests prime the seeded club in `test/setup.ts`;
  e2e `serveApi` answers the club route by default.
- **The guide reads the club** (BM-12): slot length via `useSmallestSlot`, contact via `useDoorFacts` (one `/me/door`
  read); unknown claims nothing. *Why:* "fifteen minutes" and a promised phone number were false at clubs that set
  otherwise. Its box step says what the v3 LCD shows (`SCAN YOUR QR CODE` with every court's minutes of light).
  Onboarding names no code period and no menu position (`CODE_KEEPS_CHANGING`: the step is a club setting and the menu is
  a bottom tab bar on a phone); there is **no court-box fingerprint step** (slot `enabled: false`, Dean 2026-10-01 — the
  box doesn't read fingerprints; passkeys are app sign-in only).
- **Registration keeps its button on a transient 5xx** (FM-1): only `tenant_not_found` / `tenant_unresolved` block
  (`isConfigurationFault`); the passkey sheet's NotAllowed/Abort is "cancelled" (FM-2); verify-email branches on
  `approved` when the API sends it and claims neither when absent (BM-11). Welcome wizard: a step rail from lg (BM-07).
- **A stalled first read says "Still trying"** after 4 s (`lib/offline/StillTrying`, the session splash's delay) on every
  member first read — Bookings, Wallet, Inbox, Invites, Wallet activity, Buy minutes, a booking's page, Profile —
  OUTSIDE the skeleton, whose `aria-busy` would mute it. No request-budget change.
- **The Wallet card reads SPENDABLE against the club's shortest booking** (R10 J10-3, `cardLevel`): a fourth state
  `short` (≥1 minute but under `sliceMinutes`) says "You can't book a court with 10 minutes — the shortest booking is 15
  minutes" and makes Buy primary (the chip's amber). The slice comes off a day read the phone holds, else today's grid is
  read (kept, shared with Bookings) only while spendable < 240; unknown slice → the plain thresholds (an unknown is never
  "you can't book"). `DaySummary` shows 0 and "12 minutes below zero" for a debt (the rail exists only from a 72rem page).
- **One end time: the SOLD end** (R9 E9-7, `detailModel.soldEnd` = `sold_ends_at ?? ends_at`): `ends_at` moves (sweep
  cut; a reversed no-show narrowed to when the relay went dark), so the member read 12:08–12:22 where the admin read 12:23.
  A played game that went dark early says "Lights off at …" (`lightsOffAt`); a no-show claims none. A no-show's title
  ends at `sold_ends_at`; a no-show and a late cancel show the ledger's own rows (charge, refund, penalty, shares, cost;
  optional `money.refunded_minutes` / `penalty_minutes`).
- **Cap words use the pill's figures** (R9 J9-4): "You've booked 2 of your 4 slots …, so 2 more is the most you can
  choose" / "Limit reached: 4 of 4" — never "the club caps it" (a group may set it and the wire does not say which); the
  banner's way on moves the SHOWN day ("Try tomorrow" only when that is today, else "Try Mon 5 Oct").
- **Door history on the phone**: a gate's `code_used` is "Code already used" (warning; the member and admin dictionaries
  share keys, test-pinned); the self-diagnosis code row says time in words ("fresh, 14 minutes left", `spokenCountdown`
  in `lib/memberDoorCopy` so copy never imports a component module).
- **The setup checklist keeps each member's last read states on the phone** (`crusaders.setup-checklist.kept`, keyed by
  `useDataOwner().who`); "Couldn't check" only for what was never read here.
- **Figures are glued at paint, never in copy functions** (R19 L19-3): `MinutesFigure` / `<Minutes>` glue their compact
  paint and the wallet hero; HeldLine, the balance sentence, the invite card, inbox headlines go through
  `keepFiguresWhole`. *Why not in copy:* tests build expected strings with the copy functions and the DOM normaliser folds
  U+00A0 only on the DOM side. A link named by glued text gets `aria-label` with plain words; exact `textContent`
  asserts normalise U+00A0.
- **The bell's badge never leaves the bell's 44px box** (R19 L19-8): right edge at `calc((100% - 44px) / 2)` from the
  glyph; type `min(0.75rem, 15px)`, padding `min(0.25rem, 4px)`, height `min(1.25rem, 22px)` (jsdom drops `min()` font
  sizes — e2e-measured).
- **Celebrations** never cover `/my-code` or an open sheet, are quiet on `/admin` (held, not dropped), are acknowledged
  on dismissal, and a queued badge says "Earned <date>" (it can open over an unrelated pending result; the frontend has
  no local trigger — the server awards only on confirmation).
- **A sheet may drop what it duplicates on a window short for its text** (R10 L10-6, `useShortSheet`): under 24 root
  ems of window HEIGHT (measured in JS — a media query's rem ignores the page font size) the accept sheet drops Cancel (the × stays; Done stays).
