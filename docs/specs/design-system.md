# Design System — Crusaders Mainframe

The product should feel like **a premium club app you are proud to open**: precise, calm, quick,
sporty without being loud. It serves a member on a phone in the club foyer and an admin running the
desk for an evening, so it is dense where admins work and generous where members tap. It ships
**light and dark** themes.

`src/frontend/src/lib/tokens.ts` is the single source of truth for values; this file explains them.
Where they disagree, one of them is wrong — fix it, never live with both.

## Foundations

1. **Tokens, never literals.** Every colour, radius, shadow, duration, z-index and type size comes from
   the token layer. A repeated class string becomes a component (or a shared constant).
2. **Three tiers.** *Primitives* (ramps: navy, slate, ink, green, blue, amber, red, orange, tin) →
   *semantic* roles per theme (`themes.light`, `themes.dark`, referencing primitives only) →
   *component* tokens (slot states, watermark, button). Shapes are DTCG-compatible; TypeScript stays
   authoritative because the tests import it.
3. **Colour reaches CSS as RGB channels.** A Tailwind `addBase` plugin emits every semantic role as
   `--color-<role>: R G B` under `:root, .light` and `.dark`, consumed as
   `rgb(var(--color-<role>) / <alpha-value>)`.
   > **The channel form is load-bearing.** A token written `var(--x, #hex)` cannot take alpha, and every
   > `/opacity` modifier on it emits **no CSS at all**. Never put a hex fallback inside `var()`.
4. **Our vocabulary only.** shadcn components are restyled to these names when added
   (`bg-background`→`bg-bg-app`, `text-muted-foreground`→`text-text-secondary`, `border-input`→
   `border-control`, `text-primary-foreground`→`text-primary-ink`, `destructive`→`danger`). Tailwind
   silently emits nothing for an unknown colour key, so the stock names are banned by test.
5. **Mobile-first, 320px up.** Touch targets ≥ 44px (`min-h-touch`). WCAG 2.2 AA in both themes,
   measured by test.

## Colour roles

| Role (Tailwind key) | Light | Dark | Notes |
|---|---|---|---|
| `bg.app` | `#F8FAFC` | `#0A1220` | canvas; dark is a navy-tinted night |
| `bg.surface` | `#FFFFFF` | `#101A2C` | cards |
| `bg.muted` | `#F1F5F9` | `#172338` | sunken fills, hovers, table heads |
| `bg.raised` | `#FFFFFF` | `#1A2740` | popover, menu, dialog, sheet, toast — dark elevation = lighter surface |
| `overlay` | `#0F172A` @45% | `#020617` @70% | scrim |
| `text.primary` | `#0F172A` | `#E6EDF7` | |
| `text.secondary` | `#475569` | `#B3C0D4` | |
| `text.muted` | `#5B6879` | `#90A0B8` | ≥4.5:1 on every background incl. soft fills |
| `border` | `#E2E8F0` | `#24324D` | **decorative only** (1.2–1.4:1 by design) |
| `control` | `#7C8DA4` | `#6B7EA0` | edge of every input/select/checkbox — ≥3:1 non-text contrast |
| `primary` / `primary.ink` / `primary.hover` | `#00498D` / `#FFF` / `#003B73` | `#2F6DB8` / `#FFF` / `#2865AE` | filled CTAs |
| `accent.strong` | `#00498D` | `#8CBAF2` | links, focus ring, selection ring |
| `accent.soft` | `#E4EDF7` | `#12294A` | |
| `brand.strong` / `ink` / `soft` / `tin` | `#00498D` / `#FFF` / `#E4EDF7` / `#CF2E30` | `#00498D` / `#FFF` / `#12294A` / `#FF6B6D` | crest colours; brand band stays navy in dark |
| `success` soft / strong / solid | `#DCFCE7` / `#15803D` / `#15803D` | `#0E2A1C` / `#4ADE80` / `#15803D` | |
| `info` soft / strong | `#DBEAFE` / `#1D4ED8` | `#12234A` / `#93B8FD` | |
| `warning` soft / strong | `#FEF9C3` / `#A16207` | `#2E2408` / `#F5C542` | |
| `danger` soft / strong / solid (+ink `#FFF`) | `#FEE2E2` / `#B91C1C` / `#B91C1C` | `#3A1418` / `#FF9B9B` / `#C73636` | |
| `armed` strong / ink | `#C2410C` / `#FFF` | `#C2410C` / `#FFF` | "tap again to confirm" |
| `ring` | = `accent.strong` | = `accent.strong` | ≥3:1 against every background |

**Crest red ("tin")** is used for exactly two things: the crest and the booking grid's **now-line** (a
squash court's tin). Never as a state colour.

> **Do not use `#7AB07A`.** An old spec called it "the Crusaders green"; it measures 2.52:1 on white.
> `tokens.test` pins it as failing. The club's real colours are crest blue `#00498D`, red `#CF2E30`, white.

> **`brand_accent_hex` is not read by anything.** Per-tenant theming is a hook, not a feature. If it is
> ever wired, it must emit channel variables for both themes and pass the contrast matrix.

### Slot-state component tokens (booking grid)

| State | Fill | Text | Edge | Non-colour cue | Watermark | Selectable |
|---|---|---|---|---|---|---|
| available | success.soft | success.strong | transparent | "Book" (+price ≥md) | yes | yes |
| selected | underlying | same | `ring-2 ring-inset accent.strong` | filled checkbox top-left | hidden | — |
| mine (future) | brand.soft | brand.strong | transparent | "Your court" + span | yes (opens cancel) | yes |
| mine · on court | brand.soft | brand.strong | transparent | live dot + "On court" | yes | yes |
| mine · past | bg.muted | text.secondary | border | "Played" / "Past" | no | no |
| booked (other) | bg.muted | text.secondary | transparent | avatar + first name | admin only | admin only |
| past (empty) | transparent | text.muted | none | "—" | no | no |
| hold / blocked | bg.muted + stripes | text.secondary | transparent | plan name + "Club hold" | no | admin (lift) |
| closed | transparent | text.muted | dashed border | "Closed" | no | no |
| restricted (peak/group/quota) | warning.soft | warning.strong | dashed warning | lock/info icon + word; tap explains | no | no |
| court not in use | bg.muted/40 | text.muted | dashed border | "Not in use" | no | no |
| now-line | — | — | 2px `brand.tin` + 8px dot in time column | "Now" caption | — | — |

## Scales

- **Spacing:** Tailwind's 4px scale; allowed steps 0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16. Named:
  `touch` 44px, `appbar` 56px, `tabbar` 64px. Page gutter `px-4 sm:px-6 lg:px-8`, page top `pt-6 lg:pt-8`,
  header→body 24px, section gap 32px, in-section 16px, card padding `p-4 sm:p-6`, field stack 16px,
  label→control 6px, toolbar gap 8px, grid row gap 4px / column gap 6px. Arbitrary spacing only inside
  `components/ui/`.
- **Type** (t-shirt keys overridden so tailwind-merge still recognises them; sizes in rem so large text
  scales): xs 12/16 (the product floor — no 10–11px text) · sm 14/20 · base 16/24 · lg 18/26 · xl 20/28 ·
  2xl 24/32 · 3xl 30/36 · 4xl 36/40 · 5xl 48/1. Weights 400/500/600/650 (`heading`)/700/800. Tracking
  `overline` .08em, `code` .2em, `tight` −.02em. Recipes in `lib/typography.ts`: `display` (Archivo 800,
  stretch 112%, tabular, tight), `h1` (Archivo 700, 2xl→sm:3xl, stretch 108%), `h2` (Figtree 650 xl),
  `h3` (Figtree 600 lg), `body`, `ui` (500 sm), `label`, `caption` (xs muted), `overline`, `numeric`.
- **Fonts:** Figtree Variable (UI/body — tabular figures; the layout tests measure it), Archivo Variable
  with its width axis (display/h1, semi-expanded), JetBrains Mono Variable (codes). Self-hosted via
  `@fontsource-variable/*` only — there is no static-weight package. In git worktrees
  `vite.config.ts` must keep `server.fs.allow` including the
  resolved `node_modules`, or every face 403s and tests measure a fallback.
- **Radius (px):** sm 6 (checkbox) · md 8 (slot cells) · lg 10 (buttons, inputs, selects, toggles) ·
  xl 14 (cards, popovers, menus) · 2xl 20 (dialogs, sheet tops, pass card) · full (avatars, pills).
- **Elevation** (CSS variables per theme): 0 canvas/cells · 1 card (border + xs) · 2 hover/sticky bars
  (md) · 3 popover (raised + border + md) · 4 dialog/sheet/toast (raised + lg).
  Light: xs `0 1px 2px rgb(15 23 42/.05)`, sm `0 1px 3px rgb(15 23 42/.08), 0 1px 2px -1px rgb(15 23 42/.06)`,
  md `0 4px 12px -2px rgb(15 23 42/.10), 0 2px 4px -2px rgb(15 23 42/.06)`,
  lg `0 12px 32px -8px rgb(15 23 42/.18), 0 4px 8px -4px rgb(15 23 42/.08)`.
  Dark: xs `0 1px 2px rgb(0 0 0/.40)`, sm `0 1px 3px rgb(0 0 0/.45), inset 0 1px 0 rgb(255 255 255/.04)`,
  md `0 6px 16px -4px rgb(0 0 0/.55), inset 0 1px 0 rgb(255 255 255/.05)`,
  lg `0 16px 40px -8px rgb(0 0 0/.65), inset 0 1px 0 rgb(255 255 255/.06)`.
- **Motion:** existing durations/easings unchanged (`press 90, fast 120, base 200, enter 220, in 180,
  hold 1200, settle 240, shake 320, count 600, breathe 1400`) plus `sheet 280`, `tick 1000`. Keyframes:
  `overlay-in/out`, `pop-in/out` (scale .96 + fade), `sheet-up/down`, `collapse-down/up`
  (`--radix-accordion-content-height`). Every animated use carries `motion-reduce:animate-none`; no
  numeric `duration-N` or `ease-[…]`.
- **z-index:** base 0 · raised 10 (time column) · sticky 20 (court headers) · sticky-corner 25 ·
  chrome 30 · actionbar 35 · overlay 40 · modal 50 · popover 60 (Radix portals above modals) · toast 70 ·
  tooltip 80 · skip 90. No `z-[…]`.
- **Widths** (`max-w-*`): `narrow` 36rem — single-task linear pages only (auth forms, change
  password, top up, not found) · `content` 64rem · `wide` 80rem · `page` 120rem (PageShell
  `full`: admin and data screens; never unbounded) · slots inside a page: `list` 24rem (a split
  view's list), `aside` 20rem / `asideWide` 24rem (a side rail, the wide one from 3xl), `form`
  40rem. Tailwind's `max-w-full` stays 100 %.
- **Tiles** (`layout.tile`, AutoGrid minimums, rem so 200 % text halves the columns): `stat` 9rem ·
  `card` 18rem · `panel` 26rem · `wide` 34rem.
- **Breakpoints:** Tailwind's, plus `3xl` 1800px. **Layout is decided by the box, not the
  viewport** wherever a primitive can: `@tailwindcss/container-queries` (pinned) — every
  PageShell is `@container/page`, and SplitView, WithAside and the Auth card name their own. The
  viewport lies beside the admin rail and at 200 % text. The plugin emits nothing for
  `@[56rem]/name:` in front of an arbitrary PROPERTY (`[grid-area:x]`); write those as
  `[@container_name_(min-width:56rem)]:[…]`.
- **Sticky offsets:** `<main>` is the scroller and sits UNDER the app bar, so sticky things use
  `top-0` / `top-6` (`layout.stickyTop` is 0), and full-height panes subtract
  `--app-chrome-height` **and every bar fixed over the scroller** — `--app-bottom-bar-height` (shown at xl
  with large text too) and a docked ContextBar's `--context-bar-height` — and scroll within themselves
  (R14 L14-1). Names never rely on `hyphens: auto`: Chromium will not hyphenate a capitalised word,
  so a long name gets its own line or more room instead (R14 L14-3).

## Theme

- `public/theme-boot.js` (external, blocking, before CSS; precached by the service worker) reads
  `localStorage["crusaders:theme"]` (`system|light|dark`), toggles `html.dark`, sets `color-scheme`.
- `lib/theme.tsx` provides `ThemeProvider`/`useTheme()`; the account menu offers System / Light / Dark.
- `index.html`: `<meta name="color-scheme" content="light dark">` + two `theme-color` metas with `media`.
- No `dark:` classes anywhere — dark is expressed only by the token variables.

## Icons

**Phosphor**, imported **only** through the barrel `src/components/ui/icons.ts`: one line per icon,
per-icon `dist/csr/<Name>` paths, exporting `<Name>Icon` and the bare `<Name>`. ESLint
`no-restricted-imports` forbids `@phosphor-icons/react` (and `lucide-react`) everywhere else, and
`icons.test` scans the tree for the same rule. `IconContext` defaults (`main.tsx`): regular, 20px,
`currentColor`. Sizes by context: inline with xs text 14 bold · buttons, inputs, badges, menus 16 ·
icon buttons, list leads, page-header actions 20 · mobile tab bar 24 (fill when active) · empty states
40 duotone · onboarding tiles 64 duotone. Every weight of an icon ships with it, so add icons
deliberately.

**No glyph on a button at rest.** Working is a spinner; success is the hand-drawn `AnimatedCheck`,
failure `AnimatedAlert` plus a shake (`ui/feedback-marks.tsx`). `ConfirmButton` wears these phases
through `useActionFeedback`; a destructive action never celebrates. `Fingerprint` (the real icon) is
reserved for genuine biometrics (passkey, capture).

## The fingerprint watermark (the club's signature affordance)

`<Interactable asChild surface="cell|card|tile|cta" watermark>` wraps a `<button>`/`<Link>`, adds
`relative isolate overflow-hidden`, `data-interactive`, `data-watermark`, and appends an aria-hidden,
pointer-events-none empty box masked to `FingerprintSimple` (light weight — a CSS mask of Phosphor's own
path, not an inline SVG, so a 200-cell grid decodes the shape once), cropped by the edge, rotated −15°,
painted in `currentColor` at per-theme opacities (`--wm-rest/hover/press`).

| Surface | Glyph | Position | Rest L/D | Hover/focus-visible | Press |
|---|---|---|---|---|---|
| cell (48px slot) | 36px | right −6, bottom −8 | .12 / .16 | .20 / .24, nudge + rotate −10° | .28 / .32, scale .96 |
| card / list item | 72px | right −12, bottom −16 | .07 / .10 | .11 / .14 | .14 / .18 |
| tile / hero | 128px | right −20, bottom −28 | .06 / .09 | .09 / .12 | .12 / .15 |
| cta (large primary) | 40px | right −6, bottom −10 | .14 / .16 | .20 | .26 |

Hover only under `@media (hover:hover)`. Hidden when selected, busy (`aria-busy`), disabled; `display:none`
in forced-colors and print; no transform under reduced motion.

**Carries it:** actionable grid cells (available, own future booking, other's future booking for admins),
interactive cards (member rows on mobile, control-board court tiles, landing tiles), large primary CTAs
("Book · 8 cr", "Top up"). **Never:** door/gate/passkey/WebAuthn/biometric-capture surfaces, the pass
card/QR, destructive/armed/danger actions, form controls, tabs/nav, icon buttons, inline links, dense
desktop table rows, toasts, the week strip, and any non-operable cell (its absence is itself the cue).
Only `ui/interactable.tsx` may import `ui/watermark.tsx`; tests enforce placement and that slot text still
clears 4.5:1 over the watermark at its maximum opacity.

## Components

`components/ui/` is the design-system layer: shadcn/ui "new-york" (Tailwind v3 flavour) on the unified
`radix-ui` package, restyled to our vocabulary, plus our own primitives. Screens import from it
directly — there are no compatibility re-exports. Rules for adding one: rewrite colour classes; no
`outline-none` / `focus-visible:ring-*` (the house `:focus-visible` outline applies); named durations
and our keyframes; `border border-transparent` on controls (forced colours); `min-h-touch`; `no-lift`
on checkbox/switch/radio/tab/toggle/menuitem/option/calendar day; icons from the barrel. Not adopted:
vaul, sonner, next-themes, react-hook-form, Radix ScrollArea.

- **button** — variants `primary`, `secondary` (tonal), `outline`, `ghost`, `danger`, `danger-soft`;
  **no link variant**. Sizes `sm` (36 visual, 44 hit), `md` 44, `lg` 52, `icon-sm`, `icon` 44,
  `icon-lg` 52. `block`, `icon`, `pending` (spinner replaces the icon, label stays, width locked,
  `aria-busy` + `aria-disabled` so focus stays), `asChild`. Heights are floors (`min-h-*`) and the
  label WRAPS rather than overflow: no forced nowrap (`white-space` is inherited, so a nowrap row such
  as a table head keeps its buttons on one line), `max-w-full`, balanced and centred, a word kept
  whole (`overflow-wrap: break-word`), a figure glued to its unit (`keepFiguresWhole`,
  `ui/figure-text.ts`; the plain label stays the accessible name). Icon gap and side padding are
  pixels. Toggles follow the same rules (review round 11).
- **icon-button** — `label` required → aria-label + tooltip.
- **field / input / textarea** — Label, Description, Error wired via `aria-describedby`/`aria-invalid`.
- **select** (Radix; `SelectValue` clamps the value to one line — never the trigger's other children) ·
  **time-select** (slice-aligned options, never free-typed) · **member-combobox** (cmdk in a Popover;
  full-height Sheet below `sm`) · **date-picker** (club days `YYYY-MM-DD`; Popover ≥ `sm`, Sheet
  below; trigger reads "Tue 23 Sep" via `date-picker-day`; the react-day-picker **calendar** is a lazy
  chunk fetched on pointer/focus intent) · **checkbox** · **radio-group** + **RadioCard** · **switch**.
- **dialog** — bottom sheet below 640px, centred `max-w-md` above; **always a close ×** (44px),
  named "Close" + the dialog's title; h2 title + description; body scrolls and its rows never shrink (`[&>*]:shrink-0`); footer
  `flex-col gap-2 sm:flex-row sm:justify-end` — never reversed, so Tab order is paint order.
  An outside click after typing keeps it open. **sheet** = Radix Dialog from bottom/right.
- **popover · tooltip** (names icon buttons only; none on touch) · **info-popover** · **accordion** ·
  **tabs** (`segmented`, `underline` — an underline list of fewer than four tabs wraps instead of scrolling) · **toggle / toggle-group** · **dropdown-menu** · **command** ·
  **skeleton** · **badge** (tones neutral/success/info/warning/danger/brand; inner `min-w-0 break-words`
  span) · **card** (Header/Title/Description/Action/Content/Footer) and **Panel** (the card surface
  with `p-4 sm:p-6` on the box, for free text, notices and action rows) · **table** · **avatar**
  (24/32/40/56/96, initials fallback) · **progress** · **separator** · **spinner**.
- **Ours, in `ui/`:** `interactable` + `watermark`, `feedback-marks`, `page-shell` (PageShell,
  PageHeader, Section), `refresh-button` (+ `Freshness`), `state-block`, `week-strip`, `action-bar`,
  `text-link`, `countdown-ring`, `pass-card`, and the layout system (R4 form factor):
  `split-view`, `with-aside`, `auto-grid` (AutoGrid, Columns), `context-bar`, with their shared
  parts in `layout.ts` (the AutoGrid template, the bottom dock, the list keys).
- **Product composites outside `ui/`** (built on it): `ConfirmButton` (two-press, armed state),
  `Toast` (live-region handling), `Alert`, `DataTable`, `SegmentedTabs` (legacy tabs, still in use),
  `ScrollArea`, `Carousel`, `Charts`/`ChartFrame`, and the app shell in `components/shell/`.

## Patterns

- **Page shell.** `PageShell width="narrow|content|wide|full"` (+ `fullFrom3xl`) owns gutters
  (`px-4 sm:px-6 lg:px-8 3xl:px-12`), top padding and section gap, and is the page's container.
  The app bar follows the frame: `max-w-page` from 3xl on a full page (`data-page-frame`, read by
  `:has()`), full-bleed with the crest over the rail on `/admin` from xl.
- **Use the width** (R4 form factor). A screen with more than one thing on it never sits in a
  phone column on a desktop:
  - **SplitView** — master–detail. The caller owns the pick (a child route or a `?param`); split
    when its box is `splitAt` wide (list pane sticky, own scroll, `[data-split-item]` rows walked
    by Up/Down/Home/End, the picked one `aria-current`); stacked, the list or the detail. Both
    panes stay mounted — CSS decides, so nothing flickers. Invites, Inbox, Members.
  - **WithAside** — a sticky `<aside aria-label>` rail beside the main column from its box's `at`
    width; `after`, `before`, `first` (DOM-first, drawn second — the Bookings games) or `sheet`.
  - **AutoGrid / Columns** — tiles by token with a column CAP and no breakpoint (`max`), or
    masonry-like columns for unequal cards.
  - **ContextBar** — `top`: a sticky strip of filters and totals; `bottom`: ONE primary verb docked
    above the tab bar in thumb reach (Top up, Invite a player, Answer an invite). A docked bar
    publishes `--context-bar-height`; `<main>`'s padding, the toasts and the booking grid's
    height budget make room for it. ActionBar shares the dock.
  - **One control, one place.** Where a verb moves between a docked bar (phone) and the page
    (desktop), `useMediaQuery` picks ONE rendering — a CSS-hidden twin is still a second button
    to a test, a screen reader's element list and a `getByRole`.
  `PageHeader`: optional back link and eyebrow, the page's only `h1`, description, actions on the
  right, freshness slot. `Section`: `section[aria-labelledby]` with h2, description, actions. No page
  sets its own root spacing or width.
- **Refresh.** `RefreshButton` (ArrowsClockwise, 44px, spins ≥ 400ms) beside `Freshness` ("Updated 12s
  ago", warning after 60s), in the header's actions slot.
- **Async.** `useAsyncAction(fn, …)` → `{run, pending, status, error, reset}`; re-entry ignored; a
  mutation button uses `pending`, never a bare `disabled={busy}`. Reads show a layout-shaped
  `Skeleton` (never "Loading…"); empty, failed and stale via `StateBlock` — a failed read is never
  rendered as an empty one.
- **Buttons vs links.** Navigation is a link; an action is a button. `TextLink` inline or standalone.
  A link may look like a button only as a navigation CTA: `<Button asChild><Link/></Button>`.
- **Dialog copy.** Dismiss = "Cancel"; multi-step = "Back"; when the primary itself cancels something,
  the dismiss names the outcome ("Keep booking"). Banned: "Keep looking", "OK".
- **Booking grid.** `48px repeat(N, minmax(104px,1fr))` mobile / `64px repeat(N, minmax(120px,1fr))`
  ≥ md; `gap` 4px rows / 6px columns; cells `h-12 rounded-md`; inset selection rings; sticky court
  header and time column; tin now-line; scrolls to now on first load; courts side by side on mobile
  with column scroll-snap and a court-chip row above 3 courts (in a ScrollArea whose fade says
  it scrolls); from 3xl a court column stops at 18rem and the frame hugs the grid.
- **Multiselect.** Enter via the toolbar ("Select slots"), long-press (450ms), a desktop checkbox
  hover, or a drag; Shift-click/arrow for ranges. A floating **ActionBar** (above the tab bar on
  mobile): × exit · "3 selected" · secondary actions · primary right; Esc clears then exits.
- **Day picker.** `WeekStrip` (Mon–Sun chips 44×56, dot on days with bookings, today ringed,
  prev/next clamped to the booking window) plus a calendar button that opens `DatePicker`.
- **Pass card (My Code).** Navy brand band (crest, club, "MEMBER", avatar), perforation notches, QR
  panel always white with a ≥ 4-module quiet zone, code in JetBrains Mono, `CountdownRing` for the
  rotating window, offline badge. First on a phone; from a 60rem page a sticky 24rem column beside what's next,
  the doors, the wallet and setup (three columns from 72rem); tap for full screen.
- **Stat tiles.** Five figures fill their rows: two columns on a phone with an odd last tile spanning
  both, a six-column track (3 + 2) from `sm`. Badge tiles are one row height (`auto-rows-fr`) with
  names clamped at two lines.
- **Code-splitting.** The entry chunk carries the shell, the public landing, sign-in and My Code (the
  service worker precaches only what `index.html` names, so an offline /my-code cannot wait on a lazy
  chunk). Every other page is `React.lazy` behind the page-shaped `RouteSkeleton` — except the admin
  frame, Overview and the two doors pages, which read the shared doors store (it dedupes only in
  flight). React + the router are a vendor chunk of their own; nothing else is grouped by hand.
- **"Offline" means the phone says so (R15 X15-3).** Copy says "You're offline" only when
  `navigator.onLine === false`. When the phone is online but the club can't be reached, it says
  "Can't reach the club" ("…showing what we had at 18:00"). This applies to stale notices, the My Code
  badge, the nothing-kept page, the minutes chip and write refusals. It reverses R8, which said
  offline whatever `onLine` said: a member on Wi-Fi with the club down was told to check a
  connection that was fine.

## Guards (tests)

`tokens` + `tokens.themes` (contrast matrix in both themes, hierarchy, control edge and ring ≥ 3:1) ·
`theme-emission` (`:root` and `.dark` emit identical channel key sets; opacity modifiers produce CSS) ·
`theme-vocabulary` (no stock shadcn names, raw palette, `dark:`, `z-[…]`, `text-[Npx]`, and no arbitrary
spacing outside `ui/`) · `icons` (one barrel, per-icon paths, no thumbs) · `affordance` (one base
hover/press/focus rule, `.no-lift` wins, nothing clickable is a bare div) · `ui/__tests__` (dialog
anatomy and focus, page shell, watermark placement and opacities, pickers, the rest) ·
`pwa-posture` and `production-posture`. The source-scanning guards use **ratcheting allow-lists**: they
fail when a new file offends *and* when a listed file has been fixed but is still listed, so a list
only ever shrinks. Browser-only facts (layout, forced colours, axe in both themes, the offline My Code
on a production build) live in `e2e/`, the design-system gallery at `/dev/primitives` (dev only)
among them.

## Charts

Recharts, loaded only with the report screens. Series colours come from `chartColors()` reading the
live theme tokens (charts re-render on theme change). Flat, axis-labelled, legible at 360px; tooltips
use the raised surface.

## Accessibility floor

WCAG 2.2 AA in both themes (measured, not eyeballed); 44px targets (24px hard floor with an extended
hit area for dense admin controls); visible `:focus-visible` outline; explicit labels; colour never
the only signal; reduced motion and forced colours honoured by every primitive; live regions for async
outcomes; dialogs trap and restore focus; the route announcer names every page.
