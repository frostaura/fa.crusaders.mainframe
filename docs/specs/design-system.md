# Design System — Crusaders Mainframe

The product should feel like **a premium club app you are proud to open**: precise, calm, quick,
sporty without being loud. It serves two very different moments — a member on a phone in the club
foyer, and an admin running the desk for an evening — so it is dense where admins work and generous
where members tap. It ships **light and dark** themes from day one.

This file is the reference every implementation lane builds against. `src/frontend/src/lib/tokens.ts`
is the single source of truth for values; this file explains them. Where they disagree, the code is a
bug or this file is stale — fix one, never live with both.

## Foundations

1. **Tokens, never literals.** Every colour, radius, shadow, duration, z-index and type size comes from
   the token layer. A test bans hex in components/pages, raw Tailwind palette classes (`slate-*`,
   `amber-*` …), arbitrary `z-[…]`, `text-[Npx]`, and stock shadcn class names. A repeated class string
   becomes a component.
2. **Three tiers.** *Primitives* (ramps: navy, slate, ink, green, blue, amber, red, orange, tin) →
   *semantic* roles per theme (`themes.light`, `themes.dark`, referencing primitives only) → *component*
   tokens (slot states, watermark, button). Shapes are DTCG-compatible so a `tokens.dtcg.json` export can
   be generated later; TypeScript stays authoritative because the tests import it.
3. **Colour reaches CSS as RGB channels.** A Tailwind `addBase` plugin emits every semantic role as
   `--color-<role>: R G B` under `:root, .light` and `.dark`, and Tailwind consumes it as
   `rgb(var(--color-<role>) / <alpha-value>)`.
   > **The channel form is load-bearing.** Tokens were once `var(--accent-soft, #E0F2FE)`; Tailwind
   > cannot inject alpha into an opaque `var()`, so every `/opacity` modifier on them emitted **no CSS at
   > all**. Never add a hex fallback inside `var()`.
4. **Our vocabulary only.** shadcn components are restyled to these token names when added
   (`bg-background`→`bg-bg-app`, `text-muted-foreground`→`text-text-secondary`, `border-input`→
   `border-control`, `bg-primary text-primary-foreground`→`bg-primary text-primary-ink`,
   `destructive`→`danger`). Tailwind silently emits nothing for an unknown colour key — the same failure
   as the `var()` bug — so a test forbids the stock names.
5. **Mobile-first, 360px up.** Touch targets ≥ 44px (`min-h-touch`). WCAG 2.2 AA everywhere, in both
   themes, measured by test.

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
  with width axis (display/h1, semi-expanded), JetBrains Mono Variable (codes). Self-hosted via
  `@fontsource-variable/*`. In git worktrees `vite.config.ts` must keep `server.fs.allow` including the
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
- **Widths:** `narrow` 36rem (My Code, auth, forms) · `content` 64rem · `wide` 80rem (admin, grid).
  Breakpoints are Tailwind defaults.

## Theme

- `public/theme-boot.js` (external, blocking, before CSS; precached by the service worker) reads
  `localStorage["crusaders:theme"]` (`system|light|dark`), toggles `html.dark`, sets `color-scheme`.
- `lib/theme.tsx` provides `ThemeProvider`/`useTheme()`; the account menu offers System / Light / Dark.
- `index.html`: `<meta name="color-scheme" content="light dark">` + two `theme-color` metas with `media`.
- No `dark:` classes anywhere — dark is expressed only by the token variables.

## Icons

**Phosphor** (`@phosphor-icons/react`), imported **only** through `src/components/ui/icons.ts` (per-icon
`dist/csr/<Name>` paths; ESLint `no-restricted-imports` forbids direct imports). Default weight regular,
size 20. Sizes/weights by context: inline with xs text 14 bold · in buttons/inputs/badges/menus 16 ·
icon buttons, list leading, page-header actions 20 · mobile tab bar 24 (fill when active) · selected
toggle fill · empty states 40 duotone · onboarding tiles 64 duotone.

**No glyph on buttons at rest.** Working = spinner; success = hand-drawn `AnimatedCheck` (stroked circle +
tick, `pathLength`-animated, held for `hold`); failure = `AnimatedAlert` + shake. The old thumbs-up/down
ActionGlyph and the `action_glyphs` club setting are retired. `Fingerprint` (the real icon) is reserved for
genuine biometrics (passkey, capture).

## The fingerprint watermark (the club's signature affordance)

`<Interactable asChild surface="cell|card|tile|cta" watermark>` wraps a `<button>`/`<Link>`, adds
`relative isolate overflow-hidden`, `data-interactive`, `data-watermark`, and appends an aria-hidden,
non-focusable, pointer-events-none `FingerprintSimple` (light weight), cropped by the edge, rotated −15°,
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

shadcn/ui "new-york" (Tailwind v3 flavour) on the unified `radix-ui` package, restyled to our vocabulary.
Rules on adding each: rewrite colour classes; remove `outline-none` / `focus-visible:ring-*` (the house
`:focus-visible` outline applies); use named durations and our keyframes; `border border-transparent` on
controls (forced-colors); `min-h-touch`; `no-lift` on checkbox/switch/radio/tab/toggle/menuitem/option/
calendar day; icons from the barrel. Not adopted: vaul (unmaintained), sonner (our Toast has proven
live-region handling), next-themes, react-hook-form, Radix ScrollArea (native scrolling keeps sticky grid
headers fast).

- **button** — variants `primary`, `secondary` (tonal), `outline`, `ghost`, `danger`, `danger-soft`;
  **no link variant**. Sizes `sm` (36 visual, 44 hit area), `md` 44, `lg` 52, `icon-sm`, `icon` 44,
  `icon-lg` 52. Props `block`, `pending` (spinner replaces leading icon, label stays, width locked,
  `aria-busy` + `aria-disabled` so focus stays), `asChild`. Weight 600, radius lg.
- **icon-button** — `label` required → aria-label + tooltip.
- **field / input / textarea** — Label, Description, Error wired via `aria-describedby`/`aria-invalid`.
- **select** (Radix) · **member-combobox** (cmdk in a Popover; full-height Sheet on small screens) ·
  **calendar + date-picker** (react-day-picker, club time zone; Popover ≥sm, Sheet <sm; trigger reads
  "Tue 23 Sep") · **time-select** (slice-aligned options, never free-typed) · **checkbox** (20px, radius
  6, 2px control edge) · **radio-group** + **RadioCard** · **switch** (44×26).
- **dialog** — CSS-responsive: bottom sheet below 640px, centred `max-w-md` above; **always a close ×**
  (44px icon button, top-right); title (h2 lg 600) + description; body scrolls; footer
  `flex-col-reverse gap-2 sm:flex-row sm:justify-end` (primary right on desktop, on top on mobile).
  Clicking the scrim after typing keeps it open. **sheet** = Radix Dialog from bottom/right.
- **popover · tooltip** (names icon buttons only — never explanations; tooltips don't exist on touch) ·
  **info-popover** (an (i) button with guidance, for Settings) · **accordion** · **tabs** (`segmented`,
  `underline`) · **toggle-group** · **skeleton** · **badge** (tones neutral/success/info/warning/danger/
  brand; keeps an inner `min-w-0 break-words` span) · **card** (Header/Title/Description/Action/Content/
  Footer) · **table** · **dropdown-menu** · **avatar** (24/32/40/56/96, initials fallback) · **progress** ·
  **separator** · **spinner**.
- **Ours:** `interactable`, `watermark`, `feedback-marks`, `page-shell` (PageShell, PageHeader, Section),
  `refresh-button` + `freshness`, `week-strip`, `action-bar`, `text-link`, `countdown-ring`, `pass-card`,
  `state-block`, `toast`.

## Patterns

- **Page shell.** `PageShell width="narrow|content|wide"` owns gutters, top padding and section gap.
  `PageHeader`: optional back link/eyebrow, the page's only `h1`, description (sm secondary,
  `max-w-prose`), actions slot on the right, freshness slot. `Section`: `section[aria-labelledby]` with h2,
  description, actions. No page sets its own root spacing/width.
- **Refresh.** `RefreshButton` = icon button (ArrowsClockwise, "Refresh", 44px) spinning ≥400ms while
  loading, beside `Freshness` ("Updated 12s ago", turns warning after 60s), always in the header's actions
  slot on the right.
- **Async actions.** `useAsyncAction(fn, {success, failure, optimistic, toast})` → `{run, pending, status,
  error, reset}`; re-entry ignored; errors become outcomes. Every mutation button uses `pending`, never a
  bare `disabled={busy}`. Read screens show a `Skeleton` that matches the layout (never "Loading…");
  empty/error via `StateBlock`; optimistic updates on book/cancel/toggles; `Progress` n/N on bulk.
- **Buttons vs links.** Navigation is a link; an action is a button. Inline `TextLink` (underlined,
  accent) or standalone `TextLink` (semibold, trailing caret). A link may look like a button only as a
  navigation CTA, via `<Button asChild><Link/></Button>`.
- **Dialog copy.** Dismiss = "Cancel"; multi-step = "Back"; when the primary itself cancels something, the
  dismiss names the outcome ("Keep booking"). Banned: "Keep looking", "Don't move any credit", "OK".
- **Booking grid.** `48px repeat(N, minmax(104px,1fr))` mobile / `64px repeat(N, minmax(120px,1fr))` ≥md;
  CSS `gap` 4px rows / 6px columns (no cell margins); cells `h-12 rounded-md`; selection rings are
  **inset** and focus outlines fit inside the gap, so neighbours never touch; sticky court header row,
  sticky time column; tin now-line; grid scrolls to now on first load. Mobile keeps courts side by side
  (members compare courts at a time) with column scroll-snap and a court-chip row when there are >3 courts.
- **Multiselect.** Enter via a toolbar icon button ("Select slots"), long-press (450ms, haptic tick),
  hovering a selectable cell's checkbox on desktop, or dragging from a selectable cell; Shift-click/arrow
  for ranges. In the mode only selectable cells show an 18px checkbox; selected = checkbox filled + inset
  ring; non-selectable cells drop their fill (dashed, AA text kept, still explain themselves on tap). A
  floating contextual **ActionBar** (above the tab bar on mobile, centred ≤640px on desktop): × exit ·
  "3 selected" + span line · secondary actions · primary on the right; count announced politely; Esc
  clears then exits.
- **Day picker.** `WeekStrip` (ToggleGroup single, arrow keys): Mon–Sun chips 44×56 (weekday xs, day lg
  tabular), dot on days with my bookings, today ringed, selected filled, past muted for members, prev/next
  week buttons clamped to the booking window, today auto-selected; a calendar button opens `DatePicker`
  to jump ahead.
- **Pass card (My Code).** Boarding-pass anatomy: navy brand band (crest, club, "MEMBER", avatar),
  perforation notches, QR panel always white with ≥4-module quiet zone, code in JetBrains Mono grouped
  "482 913", `CountdownRing` for the rotating window, offline badge ("Offline · your code still works").
  Centred in a `narrow` shell at every width; tap for full-screen (white, wake lock, brightness hint).

## Guards (tests)

`tokens.themes` (contrast matrix × both themes, hierarchy, ring ≥3:1, watermark composite, slot pairs) ·
`theme-emission` (`:root` and `.dark` emit identical key sets) · `theme-vocabulary` (no stock shadcn
names, raw palette, `dark:`, `z-[`, `text-[Npx]`, arbitrary spacing outside `ui/`) · `icons` · `watermark`
· `dialog-anatomy` · `links-buttons` · `async-posture` · `page-shell` · no raw `<select>` / date / time /
checkbox / radio inputs outside `components/ui`. Sweep guards use **ratcheting allow-lists**: they fail
when a new file offends *and* when a listed file has been fixed but is still listed, so the list only
shrinks and every phase stays green.

## Charts

Recharts. Series colours come from `chartColors()` reading the live theme tokens (charts re-render on
theme change): accent, success, info, warning, danger strong. Flat, axis-labelled, legible at 360px;
tooltips use the raised surface.

## Accessibility floor

WCAG 2.2 AA in both themes (measured, not eyeballed); 44px targets (24px hard floor with an extended hit
area for dense admin controls); visible `:focus-visible` outline; explicit labels; colour never the only
signal; reduced-motion and forced-colors honoured by every primitive; live regions for async outcomes;
dialogs trap and restore focus; the route announcer names every page.
