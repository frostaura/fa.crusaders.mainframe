import { createContext, useContext } from "react";
import { DEFAULT_CURRENCY_SYMBOL } from "./currency";

/**
 * The club's choices about how the product talks back — read once, tolerated absent.
 *
 * <p>
 * There is exactly one of these today and it is item 12's: which pair of glyphs a confirm and
 * a decline wear. It is a module rather than a boolean threaded through `Button` because the
 * whole point of the feedback theme is that no call site configures it; the glyph set is a
 * property of the club, not of the button, and a prop would make it a property of whoever
 * remembered to pass one.
 * </p>
 */

/**
 * Which pair of marks an affirm and a decline wear.
 *
 * <p>
 * <b>`thumbs` is the default, and that is a ruling rather than a preference.</b> The member
 * design recommended ✓/✕, on the grounds that a thumbs-up reads as an obscenity in Iran, Iraq
 * and parts of West Africa and as dismissive in Greece — and that the offensive reading
 * persists most strongly among older members. The counter-argument won: this is one club, in
 * Durban, where a thumbs-up is unambiguously positive, and the founder asked for thumbs by
 * name for an audience that finds a gesture easier to read than a mark. The research is not
 * wrong; it is about a different deployment, and the setting is here so a club in one of those
 * places can have ✓/✕ without a code change.
 * </p>
 *
 * <p>
 * Either way the glyph is never alone. NN/g's icon research is unambiguous that without a
 * standard usage an icon needs a text label beside it, and every glyph this theme draws sits
 * beside a word — the glyph is the fast read, the word is the truth.
 * </p>
 */
export type ActionGlyphSet = "thumbs" | "marks";

/** What a club gets when it has never said, and what an older API's silence means. */
export const DEFAULT_ACTION_GLYPHS: ActionGlyphSet = "thumbs";

/**
 * The club's setting, or the default — for a value that arrived over the wire.
 *
 * <p>
 * <b>Unknown is not false.</b> A field this client has never heard of, a `null`, a number, a
 * mis-cased string: every one of them means "the club has not chosen", which is the default,
 * and never "the other one". The backend lane is still building the settings key, so the
 * commonest case on the day this ships is `undefined` — and a client that treated that as a
 * signal would flip the whole product's glyphs on a deploy nobody asked for.
 * </p>
 */
export function readActionGlyphSet(raw: unknown): ActionGlyphSet {
  return raw === "thumbs" || raw === "marks" ? raw : DEFAULT_ACTION_GLYPHS;
}

export type ClubUi = {
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
