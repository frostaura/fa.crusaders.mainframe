import { createContext, useContext } from "react";
import { DEFAULT_CURRENCY_SYMBOL } from "./currency";

/**
 * The club's choices about how the product talks back — read once, tolerated absent. One field
 * today: the currency symbol.
 */
export type ClubUi = {
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
  currencySymbol: DEFAULT_CURRENCY_SYMBOL,
};

/**
 * `null` when nothing has provided one, which is deliberate and is not an error.
 *
 * <p>
 * Every primitive in this product is rendered by its own unit test without the app's provider
 * stack around it, and a context that threw would turn every such test red for a reason that
 * has nothing to do with the component. {@link useClubUi} answers the default instead, which is also what a page
 * rendered before the profile has arrived needs.
 * </p>
 */
export const ClubUiContext = createContext<ClubUi | null>(null);

/** The club's UI choices, or the defaults where nothing has said yet. Never throws. */
export function useClubUi(): ClubUi {
  return useContext(ClubUiContext) ?? CLUB_UI_FALLBACK;
}
