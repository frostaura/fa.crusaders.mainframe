import { readCurrencySymbol, setClubCurrencySymbol } from "./currency";
import { useProfile } from "./useProfile";

/**
 * Feeds the club's money symbol from the payload that already reaches every signed-in screen.
 *
 * <p>
 * <b>No new request.</b> `/me/profile` is fetched once per session by `ProfileProvider` and is
 * the only member-facing payload that is read on every route, so an optional
 * <code>currency_symbol</code> on it costs nothing. The alternative — a second endpoint for one
 * string — would be a round trip on the critical path of the first paint, for a value whose
 * absence is already handled.
 * </p>
 *
 * <p>
 * It sits INSIDE `ProfileProvider`. Before the profile lands, and for a signed-out screen that
 * has no profile at all, `profile` is null and the formatters answer the default.
 * </p>
 */
export function ClubUiProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useProfile();

  // The money formatters are pure functions reached from `lib/*Copy.ts`, which are not
  // components and cannot read a context — so the symbol is pushed into the module store they
  // do read. Set during render rather than in an effect, because a sentence composed on the
  // first paint must already carry the right symbol: an effect runs after it, and the club
  // would see one frame of rand.
  //
  // Idempotent and unconditional, which is what makes a second club in the same tab safe:
  // `setClubCurrencySymbol` resets to the default when a profile carries no symbol, so a
  // sign-out cannot leave the previous club's standing over the next one's money.
  setClubCurrencySymbol(readCurrencySymbol(profile?.currency_symbol));
  return <>{children}</>;
}
