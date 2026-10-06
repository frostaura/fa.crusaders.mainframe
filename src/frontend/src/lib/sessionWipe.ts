import { clearOfflineCache } from "./pwa";
import { forgetLastKnown } from "./lastKnown";
import { forgetClubZone } from "./clubZone";
import { wipeMemberCode } from "./memberCode/keyStore";
import { wipeMemberData } from "./offline/queryCache";
import { clearLastIdentity } from "./lastIdentity";

/*
 * What a session leaves on this browser, and the wipe that takes it away — out of `auth.tsx` so the
 * demo club's mode switch (`components/demo/switchClub`, a lazy admin chunk) can run the very same
 * wipe a sign-out runs.
 */

/**
 * A session was given up: the id goes, and everything the page stored under it goes with it.
 *
 * <p>
 * Called from the sign-outs only — `logout` and "Sign out everywhere". It used to run on an
 * expiry too, on the argument that a shared club phone's session usually ends with nobody
 * pressing anything. The refresh cookie changed that argument (a session now lapses only after
 * 30 idle days or a server-side revocation), and the P7 decision settles the rest: only an
 * explicit sign-out wipes the member code's key (F4.1, see `endTakenAway`).
 * </p>
 *
 * <p>
 * It is the other half of `clearOfflineCache()`, not a duplicate of it. That purges the Cache
 * API; the member code page's last-known store is `localStorage`, which no cache purge touches,
 * and until D3 nothing ever cleared it because nothing ever rendered it while signed out.
 * </p>
 */
function forgetIdentity(): Promise<void> {
  clearLastIdentity();
  forgetLastKnown();
  // R3-3 — and the club goes too. The remembered zone is the CLUB's, not the member's, and a
  // club-desk tablet is one browser profile shared by whoever holds it; a second club's admin
  // signing in on it must not read the first club's midnight until their own payload lands.
  forgetClubZone();
  // D1 — the member code's key goes with the session (spec §10: "logout wipes the phone's key
  // and does not rotate"). It is the one thing on this phone that can open a door for this
  // member with no network, so a club phone handed to the next person must not keep it.
  return wipeMemberCode();
}

/**
 * Everything the browser holds for the session in hand — offline caches (never the shell, M5-1),
 * kept reads, the confirmed identity, the code's key, door facts and the club's zone — but not
 * the token. Resolves once the asynchronous stores are gone.
 */
export function wipeSessionData(): Promise<unknown> {
  return Promise.all([clearOfflineCache(), wipeMemberData(), forgetIdentity()]);
}
