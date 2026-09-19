# Design System — Crusaders Mainframe

The visual language is **Monday.com adjacent**: soft, light, structured, easy on the eyes for long admin sessions, friendly enough for players on a phone in a club gym foyer. The aesthetic is "elegant operational tool", not "consumer entertainment app".

## Foundational principles
1. **Soft over harsh.** Greys on greys. No pure black on pure white. Borders are 1px `slate-200`, dividers are subtler.
2. **Light by default.** White / off-white backgrounds with low-saturation accent chips for status. Dark mode is a v2 concern — don't over-invest now.
3. **Color tells you something.** Status colors are functional, not decorative. Same color = same meaning everywhere.
4. **Consistency through tokens.** Everything goes through Tailwind theme tokens — no inline hex codes in components.
5. **Mobile-first responsive.** Designed at 360px width first, scales up. The booking grid is the hardest layout — see "Booking grid" below.

## Typography
- **Body & UI:** [Figtree](https://fonts.google.com/specimen/Figtree), weights 400 / 500 / 600 / 700. Self-host via `@fontsource/figtree` to avoid Google Fonts CDN coupling.
- **Display (hero numbers, large headlines):** Figtree 700 with tighter tracking (`tracking-tight`).
- **Monospace (codes, IDs, transaction refs):** `JetBrains Mono` or fallback to `ui-monospace`. Used sparingly.
- **Type scale (Tailwind):** `text-xs` (12) · `text-sm` (14) · `text-base` (16) · `text-lg` (18) · `text-xl` (20) · `text-2xl` (24) · `text-3xl` (30) · `text-4xl` (36).
- **Body line height:** 1.5. Headline line height: 1.2.

## Color palette
Soft, low-saturation. Hex values are starting points; finalise after a brand-pass with the Crusaders committee.

### Neutrals (the workhorse)
- `bg-app` — `#F8FAFC` (slate-50). Default page background.
- `bg-surface` — `#FFFFFF`. Card / panel background.
- `bg-muted` — `#F1F5F9` (slate-100). Inactive areas, table headers, hover states.
- `border-default` — `#E2E8F0` (slate-200). All borders unless specified.
- `text-primary` — `#0F172A` (slate-900). Body and headlines.
- `text-secondary` — `#475569` (slate-600). Secondary copy, labels.
- `text-muted` — `#94A3B8` (slate-400). Hints, placeholders, timestamps.

### Functional accents (each with a `-soft` and `-strong` variant)
| Token | Soft (background) | Strong (text/icon) | Meaning |
| --- | --- | --- | --- |
| `success` | `#DCFCE7` (green-100) | `#15803D` (green-700) | Available slot, completed booking, top-up success |
| `info` | `#DBEAFE` (blue-100) | `#1D4ED8` (blue-700) | Reserved by me, neutral informational |
| `warning` | `#FEF9C3` (yellow-100) | `#A16207` (yellow-700) | Inside penalty window, low balance |
| `danger` | `#FEE2E2` (red-100) | `#B91C1C` (red-700) | No-show, declined payment, cancellation with penalty |
| `accent` | `#E0F2FE` (sky-100) | `#0369A1` (sky-700) | Brand accent, primary CTAs (per-tenant overridable) |

### Per-tenant brand accent
The `accent` family is defined in `src/frontend/src/index.css` as RGB channels — `--accent-strong-rgb` / `--accent-soft-rgb` — which the Tailwind tokens consume through `<alpha-value>`. **Crusaders' accent is the club's own crest blue `#00498D`, with `#E4EDF7` as its soft tint.** Both measured in `src/frontend/src/tokens.test.ts`: 8.98:1 on white.

> **Do not use `#7AB07A`.** This document called it "the Crusaders green" and the seeder wrote it into `tenant_settings`, but it measures **2.52:1 on white** — it can carry neither body text nor a focus ring (3:1 floor), and it cannot be a fill under white text. `tokens.test.ts` now pins it as failing so it cannot be adopted on the strength of this file. The club's real colours, sampled from the Northwood Crusaders crest, are blue `#00498D`, red `#CF2E30` and white.

> **The channel form is load-bearing.** These tokens used to be `var(--accent-soft, #E0F2FE)`, and Tailwind cannot inject alpha into an opaque `var()` — so every `/opacity` modifier on them emitted **no CSS at all**. `ring-accent-strong/30` and `hover:border-accent-strong/60` were dead in the shipped stylesheet. Anything hex-valued is unaffected.

> **`brand_accent_hex` is not read by anything.** The seeder and `ProductionBootstrap` write it, and no code in `src/frontend/src` fetches it or calls `setProperty`. Per-tenant theming is a hook that is not yet wired; the values above are what every tenant actually renders.

## Spacing & rhythm
- **Spacing scale:** Tailwind defaults (`1` = 4px). Use multiples of 4. Avoid arbitrary values.
- **Card padding:** `p-4` (mobile) / `p-6` (≥md).
- **Section gaps:** `gap-6` between cards, `gap-3` within cards.
- **Touch targets:** minimum 44x44 px. Buttons default to `h-11 px-5`.
- **Border radius:** `rounded-lg` (8px) for cards / inputs; `rounded-xl` (12px) for modals / sheets; `rounded-full` for avatars and pill badges.

## Components (built on shadcn/ui)
Use shadcn/ui primitives. Customize via the theme tokens above, not by forking components. Specific overrides:

- **Button:** `default` variant uses `accent`; `destructive` uses `danger`; `ghost` for tertiary actions. All buttons have `h-11` minimum on mobile.
- **Input / Select / Textarea:** `bg-surface` with `border-default`. Focus state is a 2px `accent` ring + `accent-soft` background tint, never a harsh blue.
- **Card:** `bg-surface` + `border-default` + `rounded-lg` + `shadow-sm`. No drop shadows heavier than `shadow-md` anywhere in the app.
- **Avatar (player photo):** circular, sizes `xs` (24) / `sm` (32) / `md` (40) / `lg` (56) / `xl` (96). Always falls back to initials on a `bg-muted` background if the photo fails to load.
- **Badge / Status chip:** `<token>-soft` background + `<token>-strong` text + `rounded-full px-2.5 py-0.5 text-xs font-medium`.
- **Toast:** top-right on desktop, bottom-center on mobile. `success` / `info` / `warning` / `danger` variants; auto-dismiss 4s except `danger` which sticks until acknowledged.

## Booking grid
The hardest layout. Specs:

- **Mobile (<768px):** **single court at a time**, vertical scroll of slices. Court switcher is a horizontal pill scroller pinned to the top. Date picker pinned below the court switcher.
- **Tablet (≥768px):** 2 courts side by side.
- **Desktop (≥1024px):** all courts side by side; if more than 6 courts, horizontal scroll with sticky left "time" column.
- **Slice cells:**
  - Available — `success-soft` background, `success-strong` "Book" affordance on hover/tap.
  - Reserved by me — `info-soft` + my name + a small cancel icon.
  - Reserved by other — `bg-muted` + their photo (avatar `sm`) + first name only. No tap action; long-press shows nothing (not even a toast).
  - Admin block — `bg-muted` with diagonal stripe pattern + label.
  - Penalty-window-imminent (your booking, <15min away) — `warning-soft` border on the cell.
- **Slice height:** corresponds to `slice_minutes`. 15m = 48px; 30m = 72px; 60m = 120px. (Tunable; goal is comfortable touch on mobile.)
- **Today indicator:** a horizontal line at "now" in the time column, `accent-strong`.

## Charts (reporting)
- Library: **Recharts** (already in the FrostAura stack).
- Color rotation: cycle through `accent-strong`, `success-strong`, `info-strong`, `warning-strong`, `danger-strong` in that order.
- No 3D, no gradients, no shadows on bars/lines. Flat, clear, axis-labeled, legible at mobile widths.
- Tooltips use the same Card style as the rest of the app.

## Accessibility floor
- WCAG AA contrast on all text/background pairs (the soft palette is built to clear this — verify with a tool).
- All interactive elements keyboard-reachable; focus rings visible (2px `accent` outline).
- Form inputs have explicit `<label>`s, never placeholder-only.
- Color is never the only signal — every status chip has both color and text/icon.
- Player photo is purely visual; the player's name is always present alongside it for screen readers.

## What "elegant" means here, concretely
- No decorative gradients on UI surfaces. (Brand splash screen / marketing site can have them; the app cannot.)
- No emoji-as-icon in the product UI. Use Lucide icons (already in the stack), `1.5` stroke width, `text-secondary` color by default.
- Animations are functional and ≤200ms: hover lift, modal fade-in, tab slide. No bouncing, no "delight" microanimations on bookings — bookings are money movements.
- White space is a feature. Resist the urge to fill empty space with widgets.
