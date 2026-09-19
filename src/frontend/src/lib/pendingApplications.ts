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
 * Call when the pending set has been re-read from the server — that is, from the members
 * list loader, and from nowhere else.
 *
 * <p>
 * This comment used to name three call sites: "approve, reject, and a members list that has
 * just been loaded from the server". There were two, both in `AdminMembers.tsx`, and the
 * third had never existed — a promise in a doc block that grep disproves in one command.
 * It is now literally one, and it is the third one: the loader. Approve and reject reload
 * the list, so notifying from the loader covers them and covers the cases they did not.
 * </p>
 *
 * <p>
 * Notifying from the loader rather than from each action is the load-bearing part, not a
 * tidy-up. The badge and this screen's own "N pending" summary count the same applications
 * from the same response, so bumping the version exactly when that response replaces the
 * list is what makes the two numbers incapable of disagreeing. Bumped from the action
 * handlers instead, they diverge on precisely the case that caused the original defect: a
 * transition the server committed and the console was told had failed.
 * </p>
 */
export function notifyPendingApplicationsChanged(): void {
  version += 1;
  for (const l of [...listeners]) l();
}
