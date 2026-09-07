/**
 * A one-number store: "the set of pending membership applications may have changed".
 *
 * <p>
 * The nav badge counting applications awaiting review re-read itself on every navigation,
 * on the reasoning that an approval is always followed by one. It is not: Approve and
 * Reject are pressed <em>on</em> <code>/admin/members</code>, the console patches the row
 * in place without refetching, and <code>location.pathname</code> never changes — so the
 * badge kept counting an applicant the admin had just dealt with, on the same screen whose
 * own summary line had already dropped to "3 pending". Two numbers, one screen, in
 * contradiction until the admin navigated away and back.
 * </p>
 *
 * <p>
 * Route changes cannot see an in-place mutation, so the mutation says so itself. This is
 * deliberately a version counter rather than the count: the badge stays the one thing that
 * asks the server what the truth is, so a failed approval that the console optimistically
 * rendered can never talk the chrome into a number nobody has confirmed.
 * </p>
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let version = 0;

/** Subscribe to "something changed"; returns the unsubscribe, as `useSyncExternalStore` wants. */
export function subscribePendingApplications(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The current version — a new value means "re-read the count". */
export function pendingApplicationsVersion(): number {
  return version;
}

/**
 * Call after any action that can add to or remove from the pending set: approve, reject,
 * and a members list that has just been loaded from the server.
 */
export function notifyPendingApplicationsChanged(): void {
  version += 1;
  for (const l of [...listeners]) l();
}
