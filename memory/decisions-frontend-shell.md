---
name: crusaders-mainframe-decisions-frontend-shell
description: "The app shell: admin tabs join the bar by container width, the header's actions wrap as one group, toasts speak through a region that was there first, coach marks and the tour clamp into view, URL-bound fields own what was typed."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the app shell, its bars, toasts and tour

Layout system: [`decisions-member-layout.md`](decisions-member-layout.md); focus rings:
[`decisions-frontend-focus-rings.md`](decisions-frontend-focus-rings.md); large text:
[`decisions-frontend-large-text.md`](decisions-frontend-large-text.md).

- **An admin's tabs join the top bar at 61rem of bar content from xl, 44rem below** (R13 L13-3, `PrimaryNav`
  `INLINE.admin`, written `max-xl:@[44rem]/appbar:` + `xl:@[61rem]/appbar:`). *Why:* from xl the crest sits over the rail
  (24vw at large text) and the row wrapped up to 58rem; the club's name joining the crest at 60rem makes 60–61 the
  tightest fit. Swept 154 xl combinations (1280–1920 px, 16–32 px text, "99+", "208 h 20 min") — all one row. Not per
  route, so tabs never jump between top and bottom from My Code to the console. The member app bar is
  `@container/appbar` (tabs inline from 44rem); the phone tab bar is `@container/tabbar`, the Admin count clamped into its
  own tab with `100cqw / --tab-count` and a width in `ch`.
- **Container queries measure the CONTENT box**: a "64rem bar" at 1024 px is 60rem inside its 2rem gutters; threshold
  sweeps record `clientWidth - padding`.
- **The bell, chip and avatar are one group** (`[data-app-header-actions]`, `ml-auto`): a wrap takes all three; the bell
  pulls back the group's gap on the wide bar (`@[44rem]/appbar:-mr-2`) — 768 px holds the admin's whole row with ~8px to
  spare, so every px there is load-bearing. Header avatar capped `max-h-full max-w-full` in its px button.
- **Anything sticky and height-capped subtracts EVERY bar fixed over `<main>`** (R14 L14-1): the admin rail,
  `WithAside`'s aside and `SplitView`'s list cap at `100dvh - --app-chrome-height - --app-bottom-bar-height -
  --context-bar-height`. *Why:* at large text an admin's tabs drop to the bottom bar from xl; the rail subtracted only
  the top bar, so Settings and Webhooks sat under the tab bar and a click on Webhooks opened My Code.
- **Toasts are announced by a region that was there first** (R19 X19-3): the viewport (`data-toast-viewport`,
  `aria-live="polite"`, additions text, NO role) is rendered empty at the root by the provider; toasts (`data-toast`) are
  inserted with no role and no `aria-label`. *Why:* NVDA/JAWS may not announce a live region inserted already full, and a
  label overrides the words; not `role="status"` on the viewport, because an always-present status broke 22 unit tests'
  unnamed `getByRole("status")`. Find a toast by `[data-toast]`, its spoken words by `[data-toast-viewport]`; wallet suites
  count `[role=status], [data-toast]` so a page's own status still counts against "said once". Dismiss is a real "Dismiss"
  button (described by the words, inset ring, 44px hit box); tapping the surface still dismisses. **Toast gutters are
  pixel-capped** (rem gutters made a one-sentence toast 410px tall at 320 / 200 %). **Never tried with a real screen
  reader** ([`state.md`](state.md)).
- **Coach marks and the tour stay in view** (R17 L17-7, R18 L18-6): marks are `sticky="always"` with the top bar in their
  collision padding (the rail scrolls on its own and "partial" let a mark ride its anchor off-screen, −498px); the tour's
  anchor is clamped into the visible band (`clampedRect` — Radix `sticky` shifts only on the alignment axis); past an edge
  the rect is a zero-height line at that edge, the outline stays on the real control.
- **A ring on the QR plate is `brand-strong`** (navy 700 in both themes): the plate is white in both, and the dark accent
  measured 2.02:1 on it.
- **A URL-bound text field owns what was typed** (R15 L15-2, `lib/useUrlText`): the URL is written after 250 ms of quiet;
  its own echo is not adopted; any other URL move is adopted and cancels a pending write. *Why:* a URL write is a
  navigation committed a render later, so a key landing before it was reset — "bartholomew" came out "w" under a 6x CPU
  throttle. Members `?q=` and the ledger's name search; `e2e/url-search-r15.spec.ts` (400 rows, 6x throttle, 30/80 ms keys).
- **Controls never dead-end focus**: stepper arrows are `aria-disabled` at their ends, never `disabled` (a disabled button
  blurs and focus fell to `<body>`); a required reason never disables its button — the press shows the FieldError and
  `focusFirstComplaint`, nothing sent, the input `aria-required` (R17 X17-7).
- **A select's list is capped**: `min(--radix-select-content-available-width, 100vw - 1rem)`, floor `min(8rem, 100vw -
  1rem)`, options `[overflow-wrap:anywhere]`. **A removed door is never named by its UUID** (`removedDoorName` ends in
  `doorDisplayName`; `removed_doors` lacks `device_code`, so it reads "Unnamed scanner").
- **`glueFigureLabel` (`ui/figure-text`) is shared by Button, ToggleGroupItem and TabsTrigger** — paint glued, accessible
  name plain; a control whose child is markup glues inside its own aria-hidden / aria-labelled span.
- **`credit-scan` also reads `index.html` and `public/*.webmanifest|html|js`** (the no-"credit" invariant reaches the shell).
