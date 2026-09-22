import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { doorFleetReopenLabel, doorsShutBannerLine, doorsShutIndividuallyBanner } from "../../lib/gateCopy";
import { type DoorsChrome } from "./useDoorsChrome";

/**
 * The club-wide shut banner, on every admin route while any door is shut (A1.5 / D5 / C8).
 *
 * <p>
 * W1.5 gives shut-all one audit row and a result screen. It gives the club nothing that says,
 * at 05:50 the next morning, that the doors are still shut — and a volunteer club that shut
 * every door after an incident discovers that state with thirty members standing outside.
 * There is no timed auto-reopen, by decision, so a standing banner is the only thing that
 * gets the state back into an admin's head.
 * </p>
 *
 * <p>
 * <b>It reads from the one shut-state source (C3).</b> The banner, the doors page's own
 * summary and the fleet result panel were three independent readers, and an admin who shut
 * every door could see three different counts on one screen at once. All three now render
 * from {@link DoorsChrome}, which the doors page refreshes on every poll and after every
 * action.
 * </p>
 *
 * <p>
 * <b>Two states, because a fleet Reopen is not always the way back (C1).</b> While a
 * shut-all is standing the banner offers it, labelled with the number it will actually
 * reopen. When the doors were shut one at a time there is no fleet control at all — the
 * request would reopen none of them, which is the "0 doors reopened" dead end — and the
 * banner links to each door instead.
 * </p>
 *
 * <p>
 * <b>A failed read renders nothing, and that is not an all-clear.</b> The banner's absence is
 * its default state, so "no banner" has never meant "no doors are shut" — which is exactly
 * why a failed read is allowed to produce it. A banner is not a place to report a failed read.
 * </p>
 *
 * <p>
 * B14: `print:hidden`. This printed across the top of the door card that goes on a wall in a
 * corridor, complete with a Reopen button, on a sheet whose whole purpose is to be true for
 * months.
 * </p>
 *
 * <p>
 * <b>C11: polite, and the live region is the SENTENCE rather than the whole banner.</b> This
 * was `role="alert"` — assertive, interrupting a screen reader mid-word — and it is
 * re-rendered on every navigation an admin makes, so a blind admin met the consequence of
 * their own decision as an interruption on Bookings, on Settings, on Members, all session.
 * Scoping the region to the sentence matters as much as the role: the banner's ACTION half
 * changes with the route (the fleet link stands down on `/admin/monitoring/doors`, per-door links
 * change), and a live region announces whenever its contents change — so a region wrapping
 * the whole banner re-announces on navigation even when the sentence is word-for-word what
 * it was.
 * </p>
 */
export function ShutDoorsBanner({ chrome }: { chrome: DoorsChrome }) {
  const { pathname } = useLocation();
  /**
   * <b>C11's other half: the one change that IS news.</b>
   *
   * <p>
   * Somebody else shutting the club's doors while this admin reads another page is not a
   * standing fact — it is an event, and this reader has no other way to see it. That
   * announcement is assertive, in its own sr-only region, so the visible banner's role
   * stays polite.
   * </p>
   *
   * <p>
   * No local "have I announced this yet" state, deliberately: the store's stamp lives for
   * exactly one read, so the banner can be a pure function of what it is handed. A banner
   * that remembered would have to remember per mount, and this one is re-rendered on every
   * navigation an admin makes.
   * </p>
   */
  const interrupt = chrome.shutChangedElsewhereAt !== null;

  const shut = chrome.doors.filter((d) => !d.enabled);
  if (shut.length === 0 || chrome.total === 0) return null;

  /**
   * C17-21: the banner's action was a link to `/admin/monitoring/doors`, which is a DEAD CONTROL once
   * you are already there — and the doors page carries the real fleet control a few hundred
   * pixels below it, so the screen offered the same action twice, once inertly. The sentence
   * is still worth carrying everywhere (it is the standing reminder the club has no
   * auto-reopen); only the link stands down where the page beneath it can do the job.
   */
  /*
   * BOTH paths, since the doors overview moved under Monitoring (D3 §3.1).
   *
   * `/admin/doors` is now a permanent redirect to `/admin/monitoring/doors`, so a check for
   * the old prefix alone answers "no" on the very page this link is a dead control on — which
   * is the C17-21 defect below, reintroduced by the move rather than by anything here.
   */
  const onDoorsPage = pathname.startsWith("/admin/doors") || pathname.startsWith("/admin/monitoring/doors");
  const byFleet = shut.filter((d) => d.shutByFleet);
  const sentence = byFleet.length > 0
    ? doorsShutBannerLine(shut, chrome.total)
    : doorsShutIndividuallyBanner(shut, chrome.total);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border-l-4 border-danger-strong bg-danger-soft px-3 py-2.5 text-sm text-danger-strong print:hidden">
      {/*
        <b>C-M1 / R3-26 — one region, written only when the words change.</b>

        The sentence was in a `role="status"` AND mirrored into a `role="alert"` that was
        churned back to `""` whenever the interrupt stood down. Two live regions carrying one
        fact is two announcements of it; a region that is unmounted and remounted on every
        navigation announces on every navigation; and this banner is on EVERY admin route,
        re-rendered by a store that polls every fifteen seconds. A blind admin met the
        consequence of their own decision over and over for a session.

        What is standing is not news. {@link Announcement} below holds the words and writes
        them into a region only when they differ from what it last said — so a poll that
        finds the same three doors shut is silent, and the admin who is told is the one for
        whom something actually changed.
      */}
      <Interruption text={sentence} when={interrupt} />
      {/*
        <b>ONE region for the standing sentence, and it is the visible banner itself.</b>
        This lives in the layout and does not unmount on navigation, so its text changes
        exactly when the club's shut state changes — which is when a polite announcement is
        wanted and the only time one is made. What C-M1 found was the MIRROR: the same
        sentence also written into a `role="alert"` that was churned back to `""`, so one
        fact was two announcements and the assertive one repeated for the session.
      */}
      <span role="status" data-testid="shut-doors-banner" className="min-w-0 break-words">
        {sentence}
      </span>
      {onDoorsPage ? null : byFleet.length > 0 ? (
        <Link
          to="/admin/monitoring/doors"
          className="ml-auto inline-flex min-h-11 items-center rounded-lg border border-danger-strong px-4 font-medium"
        >
          {doorFleetReopenLabel(byFleet.length)}
        </Link>
      ) : (
        // C17-21: the fleet link was a dead control once you were already on /admin/monitoring/doors.
        // A per-door link is never dead — it goes somewhere the reader is not.
        <span className="ml-auto flex flex-wrap gap-2">
          {shut.map((door) => (
            <Link
              key={door.id}
              to={`/admin/monitoring/doors/${door.id}`}
              className="inline-flex min-h-11 items-center rounded-lg border border-danger-strong px-4 font-medium"
            >
              {door.name}
            </Link>
          ))}
        </span>
      )}
    </div>
  );
}


/**
 * <b>The one change that is genuinely news, said once (C11 / C-M1 / R3-26).</b>
 *
 * <p>
 * Somebody else shutting the club's doors while this admin reads another page is an event
 * this reader has no other way to see. Everything else about the shut state is STANDING, and
 * standing facts are the visible banner's own polite region — mirroring them here was one
 * fact announced twice, on a component that is re-rendered on every navigation an admin makes
 * and re-read every fifteen seconds.
 * </p>
 */
/**
 * <b>What has already been said, at MODULE scope — and the scope is the whole fix.</b>
 *
 * <p>
 * A ref inside the component remembers nothing across an unmount, and this banner lives in a
 * layout that re-renders on every navigation. Kept per session, so a sentence is announced
 * when it starts being true and never again — which is what "standing" means.
 * </p>
 */
let lastAnnounced: string | null = null;

/**
 * How long the sentence stays in the live region before it is emptied again.
 *
 * Long enough that a mutation observer — and a screen reader's own queue — has it; short
 * enough that it is not a second, permanent copy of the banner in the reading order.
 */
const ANNOUNCE_MS = 150;

/** Tests get a fresh session. Nothing in the app calls this; a page load is the real reset. */
export function resetShutBannerAnnouncements(): void {
  lastAnnounced = null;
}

function Interruption({ text, when }: { text: string; when: boolean }) {
  const [said, setSaid] = useState("");

  useEffect(() => {
    if (!when) return;
    if (lastAnnounced === text) return;
    lastAnnounced = text;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- writes the region exactly once per change of words
    setSaid(text);
    /**
     * <b>Announce, then empty.</b>
     *
     * A screen reader queues on the MUTATION; the text does not have to stay. Leaving it
     * there puts a second copy of the sentence in the reading order two nodes from the
     * visible banner, so somebody browsing the page meets the same fact twice — which is
     * exactly the mirroring C-M1 found, reintroduced by its own fix.
     */
    const clear = window.setTimeout(() => setSaid(""), ANNOUNCE_MS);
    return () => window.clearTimeout(clear);
  }, [text, when]);

  // One assertive region, always mounted — a live region has to be in the document before it
  // can announce — and empty except for the moment it is saying something. TWO things empty
  // it, and both matter: the store's own stamp lives for exactly one read, so `when` stands
  // down on the next poll, and the timer covers a tab that is not polling. What must never
  // happen is that it keeps the sentence: an sr-only region that does is a second copy of
  // the banner two nodes away, which is the mirroring C-M1 found.
  return <span role="alert" className="sr-only">{when ? said : ""}</span>;
}
