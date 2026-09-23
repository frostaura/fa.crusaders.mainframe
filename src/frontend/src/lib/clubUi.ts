import { createContext, useContext } from "react";
import { DEFAULT_CURRENCY_SYMBOL } from "./currency";

/**
 * The club's choices about how the product talks back — read once, tolerated absent.
 *
 * <p>
 * Two fields: the currency symbol (live) and `actionGlyphs` (<b>deprecated, read but inert</b>).
 * </p>
 */

/**
 * @deprecated R8 / D5 — the thumbs-up/down `ActionGlyph` is retired, and with it the club's choice
 * between thumbs and ✓/✕. A button at rest now wears no glyph at all; working is a spinner, and
 * the outcome is the hand-drawn `AnimatedCheck` / `AnimatedAlert` for every club
 * (`components/ui/feedback-marks.tsx`). The type and the reader survive only so the settings
 * payload and `/me/profile` still parse; nothing draws from the value. The key itself is removed
 * in the hardening phase (P10), with the settings field.
 */
export type ActionGlyphSet = "thumbs" | "marks";

/** @deprecated See {@link ActionGlyphSet}. What an absent setting reads as; it changes nothing. */
export const DEFAULT_ACTION_GLYPHS: ActionGlyphSet = "thumbs";

/**
 * @deprecated See {@link ActionGlyphSet}. Still tolerant — unknown is the default, never "the
 * other one" — so an old payload parses; the answer has no effect on anything drawn.
 */
export function readActionGlyphSet(raw: unknown): ActionGlyphSet {
  return raw === "thumbs" || raw === "marks" ? raw : DEFAULT_ACTION_GLYPHS;
}

export type ClubUi = {
  /** @deprecated Read from the profile and carried, but nothing draws from it (R8 / D5). */
  actionGlyphs: ActionGlyphSet;
  /**
   * The symbol the club's REAL MONEY figures wear — `R`, `R$`, `CHF`.
   *
   * <p>
   * Here for a component that needs to say it in prose ("Top-up block (R)"). The FORMATTERS
   * do not read it from here: they are pure functions called from `lib/*Copy.ts`, which are
   * not components, so they read the module store in `currency.ts` that this provider writes.
   * One value, two readers, and they cannot disagree because the provider sets both from the
   * same field.
   * </p>
   *
   * <p>
   * <b>It is not the credit unit.</b> Credits convert at `credits_per_zar_*` and keep a unit
   * of their own — see `currency.ts`.
   * </p>
   */
  currencySymbol: string;
};

export const CLUB_UI_FALLBACK: ClubUi = {
  actionGlyphs: DEFAULT_ACTION_GLYPHS,
  currencySymbol: DEFAULT_CURRENCY_SYMBOL,
};

/**
 * `null` when nothing has provided one, which is deliberate and is not an error.
 *
 * <p>
 * Every primitive in this product is rendered by its own unit test without the app's provider
 * stack around it — `components.test.tsx` mounts a bare `Button` — and a context that threw
 * would turn "this component has a glyph now" into two dozen broken tests that say nothing
 * about the glyph. {@link useClubUi} answers the default instead, which is also what a page
 * rendered before the profile has arrived needs.
 * </p>
 */
export const ClubUiContext = createContext<ClubUi | null>(null);

/** The club's UI choices, or the defaults where nothing has said yet. Never throws. */
export function useClubUi(): ClubUi {
  return useContext(ClubUiContext) ?? CLUB_UI_FALLBACK;
}
