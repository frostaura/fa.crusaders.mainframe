import { useMemo } from "react";
import { ClubUiContext, readActionGlyphSet, type ClubUi } from "./clubUi";
import { readCurrencySymbol, setClubCurrencySymbol } from "./currency";
import { useProfile } from "./profile";

/**
 * Feeds the club's UI choices from the payload that already reaches every signed-in screen.
 *
 * <p>
 * <b>No new request.</b> `/me/profile` is fetched once per session by `ProfileProvider` and is
 * the only member-facing payload that is read on every route, so an optional
 * <code>action_glyphs</code> on it costs nothing. The alternative — a second endpoint for one
 * string — would be a round trip on the critical path of the first paint, for a value whose
 * absence is already handled.
 * </p>
 *
 * <p>
 * It sits INSIDE `ProfileProvider` and outside everything that draws a glyph. Before the
 * profile lands, and for a signed-out screen that has no profile at all, `profile` is null and
 * {@link readActionGlyphSet} answers the default — so the sign-in screen's buttons and the
 * booking dialog's buttons wear the same marks, which is the whole reason this is central.
 * </p>
 */
export function ClubUiProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useProfile();
  const actionGlyphs = readActionGlyphSet(profile?.action_glyphs);
  const currencySymbol = readCurrencySymbol(profile?.currency_symbol);

  // The money formatters are pure functions reached from `lib/*Copy.ts`, which are not
  // components and cannot read this context — so the symbol is ALSO pushed into the module
  // store they do read. Set during render rather than in an effect, because a sentence
  // composed on the first paint must already carry the right symbol: an effect runs after
  // it, and the club would see one frame of rand.
  //
  // Idempotent and unconditional, which is what makes a second club in the same tab safe:
  // `setClubCurrencySymbol` resets to the default when a profile carries no symbol, so a
  // sign-out cannot leave the previous club's standing over the next one's money.
  setClubCurrencySymbol(currencySymbol);

  // Memoised on the VALUES rather than on the profile object: `ProfileProvider` replaces the
  // object on every refresh, and a new context value re-renders every consumer of it — which
  // here is every button in the product.
  const value = useMemo<ClubUi>(
    () => ({ actionGlyphs, currencySymbol }), [actionGlyphs, currencySymbol]);
  return <ClubUiContext.Provider value={value}>{children}</ClubUiContext.Provider>;
}
