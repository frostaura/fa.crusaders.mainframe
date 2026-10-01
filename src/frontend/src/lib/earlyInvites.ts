import { getDataOwner } from "./offline/queryCache";
import { playersEndpoints } from "./playersApi";

/**
 * The member's open invites (`GET /me/invites`), asked for at the first sign that a page reading
 * them is about to open — a link to it pressed, hovered or focused (`routeChunks.routeIntent`).
 *
 * <p>
 * <b>Why (review round 5, the first in-app Bookings visit).</b> Bookings tapped right after My Code
 * showed took 1.5–1.6 s on the phone profile, and its last read — the invites badge's — started
 * only once the page's ~30 files had arrived and run: one more round trip in a row, after the code.
 * Asked for with the code, it lands while the code is still arriving.
 * </p>
 *
 * <p>
 * One answer, taken once, by the first reader that mounts within {@link FRESH_MS} and for the same
 * member (`useMyInvites`' first read). Anything later reads again: an invite list is a cue a member
 * acts on, so a minutes-old early answer must never stand in for a fresh one.
 * </p>
 */
type Answer = Awaited<ReturnType<typeof playersEndpoints.myInvites>>;

const FRESH_MS = 5_000;

let early: { who: string; at: number; answer: Promise<Answer> } | null = null;

/** Start the read now, for the member this phone holds. A hint: a failure is the reader's to see. */
export function prefetchMyInvites(): void {
  const who = getDataOwner();
  if (!who) return;
  if (early && early.who === who && Date.now() - early.at < FRESH_MS) return;
  const answer = playersEndpoints.myInvites();
  // Nobody may take it; a rejection nobody awaits must not surface as an unhandled one.
  answer.catch(() => undefined);
  early = { who, at: Date.now(), answer };
}

/** The read started early for this member, if one is fresh — once. Null: read it yourself. */
export function takeMyInvites(): Promise<Answer> | null {
  const taken = early;
  early = null;
  if (!taken || taken.who !== getDataOwner() || Date.now() - taken.at > FRESH_MS) return null;
  return taken.answer;
}
