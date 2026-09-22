import { Link } from "react-router-dom";
import type { MemberDoor } from "../../lib/api";
import type { LastKnownDoor } from "../../lib/lastKnown";
import { clubClock } from "../../lib/clubClock";
import {
  type CodeOnScreen,
  DOOR_SECTION_UNKNOWN,
  OFFLINE_DETAILS_SUMMARY,
  STANDING_HEADING,
  STANDING_LOADING,
  USE_MEMBER_CODE_INSTEAD,
  type ReadFailure,
  asOfMayHaveChanged,
  describeStanding,
  offlineDetailsBody,
  standingFailed,
} from "../../lib/memberDoorCopy";
import { Button } from "../Button";
import { cn } from "../../lib/utils";
import { MEMBER_DOOR_ACTION_LINK, MEMBER_DOOR_LINK_TAPPABLE } from "./links";

/**
 * "What opens the door for you right now" — the standing facts, below the QR.
 *
 * <p>
 * Below, because it is sofa content. A member at a door already knows what they want;
 * they want the QR and, if it failed, the reason. Above the QR this sentence would cost
 * the hero its place for something nobody at a door reads.
 * </p>
 *
 * <p>
 * It is the one block on this page that knows the club's POLICY — `/me/qr/generate` does
 * not carry one, which is why `describeDoor()` on the code card names the rule without
 * claiming to know it. That difference is the whole reason both exist, and why the code
 * card's clause is restored the moment this line is absent, stale or failed.
 * </p>
 *
 * <p>
 * <b>Four states, not three, and the fourth is D1.</b> A live answer, a live answer this
 * page can no longer re-read, a cached one, and — new — no answer of any kind at a page
 * whose every read has failed. That last one used to render nothing at all, on the screen
 * of the one member who most needed a sentence.
 * </p>
 */
export function StandingLine(props: {
  door: MemberDoor | null;
  cached: { value: LastKnownDoor; savedAt: string } | null;
  cachedMinutesAgo: number;
  loading: boolean;
  /**
   * Which failure the last read was, or null while it succeeded.
   *
   * <p>
   * It was a bare `failed` boolean, and the sentence it produced blamed the member's
   * phone for a 500 the club's own API had answered with. Who failed is the difference
   * between "move somewhere with signal" and "there is nothing on this phone to fix".
   * </p>
   */
  failure: ReadFailure | null;
  /** Which of the member's two codes is on screen, so a sentence can say which it is about. */
  code: CodeOnScreen | null;
  /** When the answer on screen was read, for the staleness marker. ISO, or null while live. */
  staleSince: string | null;
  /**
   * Is there a code on this screen a door could read right now? R3-8.
   *
   * <p>
   * <b>"A live member code of yours opens the club door" was rendered under a card reading
   * "This code has run out and can't be renewed without signal."</b> The first sentence is
   * about the club's rule and the second about the glass, and nothing said so — so a member
   * standing in the dark with no code read a promise about one. The rule is still worth
   * stating; what this flag withdraws is the last clause of it.
   * </p>
   */
  hasLiveCode: boolean;
  /** Switches the page to the member's own code. E-H2 (3). */
  onUseMemberCode: () => void;
  /**
   * Something ABOVE this section is already offering the same next act.
   *
   * <p>
   * The decision card renders "Book a court" when the last refusal was `no_booking`; this
   * line renders it when the club's policy wants a booking and the member has none. Those are
   * the same fact seen from two sides, and on one screen they were two identical filled
   * buttons a few hundred pixels apart — which a member outside a locked door reads as two
   * different things they have not understood.
   * </p>
   *
   * <p>
   * The EVENT outranks the standing rule while it is on screen, and the card is dismissible:
   * dismissing it hands the offer straight back here, so the one control a stuck member needs
   * is never absent. This line does not decide that — it cannot see the card — which is why
   * the page passes it in.
   * </p>
   */
  actionOfferedAbove?: boolean;
}) {
  const { door, cached, cachedMinutesAgo, loading, failure, code, staleSince, onUseMemberCode } = props;
  const codeState = { hasLiveCode: props.hasLiveCode };

  if (door) {
    const line = describeStanding(door, code, codeState);
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          {STANDING_HEADING}
          {/*
            D6. `useMemberDoor` keeps the last good answer when a later read fails, which is
            right — throwing away a true answer because the next request did not land would
            leave the member with less. What was wrong is that it went on being rendered in
            the present tense with nothing to say it was from ten minutes ago, beside a code
            card saying "this code has run out". A cached fact carries its age.
          */}
          {staleSince && (
            <span className="font-normal text-text-muted"> — {asOfMayHaveChanged(clubClock(staleSince, door.timezone))}</span>
          )}
        </h2>
        <p className="text-sm text-text-secondary">{line.body}</p>
        {/* E-H2 / D5: which code each sentence is about, and when its window runs. */}
        {line.codeLine && <p className="text-sm text-text-secondary">{line.codeLine}</p>}
        {/* B4 / E-H1: both halves of what a shut door does, and nothing promised. */}
        {line.shutLine && <p className="text-sm text-warning-strong">{line.shutLine}</p>}
        {line.offerMemberCode && (
          <Button variant="outline" className="w-full sm:w-auto" onClick={onUseMemberCode}>
            {USE_MEMBER_CODE_INSTEAD}
          </Button>
        )}
        {line.action?.kind === "book_a_court" && !props.actionOfferedAbove && (
          <Link to="/schedule" className={MEMBER_DOOR_ACTION_LINK}>
            {line.action.label}
          </Link>
        )}
        <OfflineHalf rosterMaxEntries={door.roster_max_entries} />
      </section>
    );
  }

  // Loading before failed: the first load of a page opened in a corridor is not a failure
  // yet, and "can't check" is the wrong sentence to greet somebody with while a request
  // is still in flight. No skeleton — there are none anywhere in this product.
  if (loading && !failure) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-medium">{STANDING_HEADING}</h2>
        <p className="text-sm text-text-muted">{STANDING_LOADING}</p>
      </section>
    );
  }

  const cachedLine = cached ? describeStanding(cached.value, code, codeState) : null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">
        {STANDING_HEADING} — <span className="text-text-muted">can't check</span>
      </h2>
      <p className="text-sm text-text-secondary">
        {cachedLine || failure
          ? standingFailed(
            cachedLine ? { body: cachedLine.body, minutesAgo: cachedMinutesAgo } : null,
            // A read that has neither succeeded nor failed cannot reach this arm, but the
            // type allows it; "network" is the safer of the two to assume, because it is the
            // one that offers the member something to do.
            failure ?? "network",
          )
          // D1's fourth state: nothing has ever landed AND nothing failed loudly enough to
          // name a culprit. The page says what it could not do and claims nothing about the
          // club — including whether it owns a door at all.
          : DOOR_SECTION_UNKNOWN}
      </p>
      {cachedLine?.shutLine && <p className="text-sm text-warning-strong">{cachedLine.shutLine}</p>}
      {cachedLine && <OfflineHalf rosterMaxEntries={cached?.value.roster_max_entries ?? null} />}
    </section>
  );
}

/**
 * P6's other half, once, behind a disclosure.
 *
 * <p>
 * Closed by default because it is not what a member at a door needs in the next fifteen
 * seconds — and present at all because a club's doors behave differently when they are
 * cut off, and a page that states only the reachable half is a page that lies on the
 * night it matters.
 * </p>
 */
function OfflineHalf({ rosterMaxEntries }: { rosterMaxEntries: number | null }) {
  return (
    <details className="text-sm">
      {/* R3-36: it was accent-coloured with no underline, ten pixels from four underlined
          links — the one interactive phrase on the block that did not look like the others. */}
      <summary className={cn("cursor-pointer", MEMBER_DOOR_LINK_TAPPABLE)}>
        {OFFLINE_DETAILS_SUMMARY}
      </summary>
      <p className="mt-1 text-text-secondary">{offlineDetailsBody(rosterMaxEntries)}</p>
    </details>
  );
}
