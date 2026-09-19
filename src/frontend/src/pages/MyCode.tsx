import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { QrCode as QrIcon, RefreshCw } from "lucide-react";
import { type MemberDoor, type MyQrCode } from "../lib/api";
import { encodeQr, qrPath } from "../lib/qr";
import { formatClock, formatCountdown } from "../lib/countdown";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { cn } from "../lib/utils";
// doors: member
import { type LastKnown, minutesSince, readLastKnown } from "../lib/lastKnown";
import {
  BOOKING_DOOR_WINDOW_CLOSED,
  CONTACT_UNKNOWN,
  type ContactKnowledge,
  DOOR_SECTION_CHECKING,
  HISTORY_ANCHOR,
  HISTORY_LINK_LABEL,
  type ReadFailure,
  USE_MEMBER_CODE_INSTEAD,
  WALK_UP_LABEL,
  codeExpiredDeadEnd,
  describeStanding,
  liveContact,
  offlineIdentDeadEnd,
  offlineNoCode,
  offlineWithCode,
  staleContact,
} from "../lib/memberDoorCopy";
import { ClubContact } from "../components/member-door/ClubContact";
import { DecisionCard } from "../components/member-door/DecisionCard";
import { FullScreenQr } from "../components/member-door/FullScreenQr";
import { DoorSection } from "../components/member-door/DoorSection";
import { useBoundaryRefresh } from "../components/member-door/useBoundaryRefresh";
import { useCountdownSeconds } from "../components/member-door/useCountdownSeconds";
import { useMemberCode } from "../components/member-door/useMemberCode";
import { useMemberDoor, useShownDecision } from "../components/member-door/useMemberDoor";

/**
 * The member's code — what they hold up to the scanner on the court box, and at the
 * club's door.
 *
 * <p>
 * <b>It was called the court code, and the name was half the defect.</b> Door-awareness
 * inside a page called "Court code", reached from a tab called "Court code", from a Home
 * tile that said "Show this at the court to turn the lights on", leaves a member standing
 * at a locked door with no reason to open it. `/court-code` stays as a permanent redirect
 * — bookmarks, the PWA start URL, any link already emailed — and everything a member sees
 * says "your code", which is the only name true both at a club with a door and at one
 * without.
 * </p>
 *
 * <p>
 * The QR carries the bare twelve-character code and nothing else. The box's scanner
 * pipeline caps an argument at 24 bytes and poisons anything longer, which is why the
 * previous design (a JWT in the QR) could never identify anyone at a court. Encoding a
 * URL, a prefix or a JSON wrapper around the code would break it just as thoroughly.
 * </p>
 *
 * <p>
 * The code is printed under the QR as well, because it is short enough to type: the
 * alphabet drops I, L, O and U so a code read off a phone at the desk cannot be misread.
 * </p>
 *
 * <p>
 * Two things about time. The countdown is derived from the server's
 * <code>expires_in_seconds</code> and the clock, never from counting ticks — a phone
 * locked in a pocket fires no ticks, and used to wake showing a live countdown over a
 * dead code. And the next code is fetched shortly <em>before</em> the current one runs
 * out and swapped in one state update, so a member at the box is never holding up a
 * code that has just died while the page fetches another. Both of those, and the pacing
 * that keeps them off the API's rate limiter, are in
 * `components/member-door/useMemberCode.ts` — none of it is about doors, and inline it
 * made this render a thirty-branch function the complexity gate was right to refuse.
 * </p>
 *
 * <p>
 * <b>Which code.</b> Left alone, the server picks: a booking code when the member has a
 * booking inside the roster window, an ident code otherwise. A booking code is refused
 * at every court but its own, so for the couple of hours before a booking that default
 * left the member with no way to walk up to a free court or pay for someone else — the
 * exact members who use the club most, sent to the desk (review finding 6). The
 * "walk up / pay for someone" switch asks for an ident code outright.
 * </p>
 */

const QUIET_ZONE = 4;

/** A QR symbol for `value`, black on white regardless of theme — scanners want contrast, not tokens. */
export function QrSvg({ value, className }: { value: string; className?: string }) {
  const matrix = useMemo(() => encodeQr(value), [value]);
  const extent = matrix.size + QUIET_ZONE * 2;
  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={`QR code ${value}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={qrPath(matrix, QUIET_ZONE)} fill="#000000" />
    </svg>
  );
}

/**
 * One clock face for the whole product, in `lib/countdown.ts` — not a second `Intl`
 * formatter here. A hand-built sibling is what this repo already found once, disagreeing
 * with its twin about midnight.
 */
const formatStart = formatClock;

/**
 * What this code does at the club's DOOR, or nothing at all.
 *
 * <p>
 * Silent unless the server said `doors: true`, which means the club has at least one
 * enabled gate. An older API sends the field not at all, a club with no gate sends it
 * false, and both must produce no sentence: telling a club with no door that its code
 * opens one is the same falsehood this function exists to fix, pointing the other way.
 * </p>
 *
 * <p>
 * <b>The two arms differ because the page knows different amounts.</b> For a booking code
 * the server sends the window outright — `door_opens_at` is `StartsAt − H` for the
 * horizon the DOOR applies, `door_closes_at` is the code's expiry — so the sentence can
 * carry clock times and does, because a member standing at a door wants to know whether
 * now is inside it. For a member code there is no window to state: under `active_member`
 * it opens at any hour and under `booking_window` it needs a qualifying booking, and this
 * page is not sent which policy is set. Printing either would be a guess, so the sentence
 * names the rule without pretending to know it.
 * </p>
 *
 * <p>
 * An opening time with no closing time still earns the first half. Inventing a clock time
 * the server did not send would be worse than a vaguer sentence that is true.
 * </p>
 *
 * <p>
 * <b>`suppressed` is the de-duplication rule, and it is one line of logic.</b> When the
 * standing line below the card is present AND carries a clock window of its own, this
 * clause is a second, vaguer copy of a fact already stated better ten pixels away — so it
 * is dropped. Whenever that line is absent, stale or failed, it comes back, because this
 * function is the FALLBACK SOURCE of door truth on the page rather than decoration:
 * `/me/qr/generate` is a different request and survives a `/me/door` that did not.
 * </p>
 */
function describeDoor(qr: MyQrCode, suppressed = false): string {
  if (suppressed) return "";
  if (qr.doors !== true) return "";
  if (qr.kind !== "booking") return " It also opens the club door whenever the club's door rules allow.";
  if (!qr.door_opens_at) return "";
  const until = qr.door_closes_at ? formatStart(qr.door_closes_at) : null;
  const end = until ?? "shortly after your booking ends";
  // The reviewer read "from a few minutes before your slot" and "opens the club door from
  // 19:50" in one paragraph, over a booking at 22:00 — two hours and ten minutes apart,
  // with nothing to say the two windows are different things. The court's is fixed and the
  // door's is the club's own early-entry setting, and the sentence now says which is which
  // rather than leaving a member to decide the screen has contradicted itself.
  return ` The club's doors open earlier than its courts do: this code opens the club door from`
    + ` ${formatStart(qr.door_opens_at)} until ${end}.`;
}

/**
 * The one-line meaning of a code, in the member's terms.
 *
 * <p>
 * Says which of the two codes is on screen and what it will and will not do, because
 * the two behave differently at the box and the member cannot tell them apart by
 * looking: a booking code opens one court at one time, an ident code identifies the
 * member anywhere. Presenting the wrong one is SEE THE DESK.
 * </p>
 *
 * <p>
 * <b>Both arms were false once codes opened doors</b> (round G3, F1). "For your booking
 * only — it works at that court" and "Identifies you at any court box" each described the
 * whole of what a code does, and each stopped being the whole of it the day the gate
 * shipped: the same twelve characters let the holder into the building. The court clauses
 * stay exactly as they were, because they are still true of COURTS — a booking code
 * really is refused at every court but its own — and {@link describeDoor} adds the door,
 * or adds nothing at a club that has none.
 * </p>
 */
function describeKind(qr: MyQrCode, suppressDoorClause = false): { headline: string; detail: string } {
  if (qr.kind === "booking") {
    const when = qr.starts_at ? ` · starts ${formatStart(qr.starts_at)}` : "";
    return {
      headline: qr.court_number != null ? `Booking code · court ${qr.court_number}${when}` : `Booking code${when}`,
      detail: "For your booking only — it works at that court, from a few minutes before your slot until it ends. "
        + "At any other court it will not be recognised." + describeDoor(qr, suppressDoorClause),
    };
  }
  return {
    headline: "Walk-up code · any court",
    detail: "Identifies you at any court box: start a walk-up on a free court, or pay for someone else's time. "
      + "It is not tied to a booking." + describeDoor(qr, suppressDoorClause),
  };
}

/**
 * The sentence at the top of the page — the first thing a member reads, and the one that
 * has to place the code before they have looked at anything else.
 *
 * <p>
 * It said the code is for "the scanner on the court box" and that it "switches the lights
 * on and marks you as arrived". At a club with a door both halves mislead: the first sends
 * a member holding their phone at a door to go and look for a court box, and the second is
 * flatly FALSE of a door. A gate decision never writes a booking, a `CheckedInAt`, a
 * ledger entry or a settlement row — walking through a door is not attendance, which is
 * the same truth `gateCopy` states for the admin side. So the attendance claim is
 * narrowed to the court rather than extended to the door.
 * </p>
 *
 * <p>
 * A string from a function, not JSX text, for the reason {@link WalkUpSwitch} carries in
 * full: lizard's .tsx lexer desyncs on an odd number of bare apostrophes in JSX text, and
 * the file already spends its odd one.
 * </p>
 */
function subtitleFor(doors: boolean): string {
  if (!doors) {
    return "Show this to the scanner on the court box. It switches the lights on and marks you as arrived.";
  }
  return "Show this to the scanner on the court box, or at the club door."
    + " At a court it switches the lights on and marks you as arrived; at a door it just lets you in.";
}

// --- when a code dies -----------------------------------------------------------
//
// `Deadline`, `deadlineFor`, `secondsUntil` and `formatCountdown` used to live here.
// They are in `lib/countdown.ts` now, imported above — not copied. The door surfaces
// count down to their own instants and a second hand-rolled two-clock reading is the
// exact failure the doors contract forbids for `relative()` on the admin side.

/**
 * What a member the club has barred sees instead of a code.
 *
 * <p>
 * The whole page, not a banner on it. Everything the normal page renders is a promise the
 * box will not keep for this member — the subtitle says the code "switches the lights on
 * and marks you as arrived", the walk-up switch offers to start on a free court or pay for
 * someone, and the QR itself is an invitation to go and hold it up at a scanner. Round 7
 * made the code inert at every box without changing any of that, so the only way to find
 * out was to stand at a court.
 * </p>
 *
 * <p>
 * The page holds this separately from its `error` state because the two are not the same
 * kind of thing: `error` is a bad minute on the network and the page goes on trying, this
 * is a decision the club has taken and the page stops making the offer by itself.
 * </p>
 *
 * <p>
 * <b>One control, and it is the whole point of the card.</b> This state used to be terminal
 * for the life of the tab: no button, and dropping the code stopped the only effect that
 * ever re-fetched, so a member whose suspension had just been lifted at the desk stood at a
 * court watching a page that would never ask again — measured at ninety seconds with zero
 * further calls. The automatic polling staying off is right; the member having no way to
 * ask was not. "Check again" is not "Refresh": there is no code on screen to refresh, and
 * what is being re-tested is the club's decision, not the network.
 * </p>
 */
function BarredCard(props: {
  reason: string;
  error: string | null;
  loading: boolean;
  onCheckAgain: () => void;
}) {
  const { reason, error, loading, onCheckAgain } = props;
  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h1 className="text-xl font-semibold">Your code</h1>
      <Card className="space-y-3">
        <p role="alert" className="text-sm text-danger-strong">{reason}</p>
        <p className="text-sm text-text-secondary">
          There is no code to show while that is the case, because a code would be turned away at the court.
          If the desk has just sorted it out, check again.
        </p>
        <Button variant="outline" onClick={onCheckAgain} disabled={loading}>
          <RefreshCw size={14} className={cn("mr-1", loading && "animate-spin")} /> Check again
        </Button>
        {error && <p className="text-xs text-danger-strong">{error}</p>}
      </Card>
    </div>
  );
}

/**
 * The "walk up / pay for someone" switch.
 *
 * <p>
 * Without it, a member with a booking within a couple of hours is handed a booking code
 * and nothing else — and a booking code is refused at every court but its own, so walking
 * up to a free court or paying for a friend was a trip to the desk.
 * </p>
 */
function WalkUpSwitch(props: { walkUp: boolean; loading: boolean; onChoose: (next: boolean) => void }) {
  const { walkUp, loading, onChoose } = props;
  return (
    <Card className="p-0 sm:p-0">
      {/*
        The WHOLE row is the label and the whole row is the target. It was a 16px checkbox
        with its name in text beside it — a target a quarter the height of everything else
        on this page, on the one control a member reaches for when the code on screen is
        the wrong one. `min-h-11` on a label that wraps the input makes the padding, the
        heading and the explanation all part of the hit area, which is both bigger than 44
        and the shape a thumb actually lands in.
      */}
      <label htmlFor="walk-up" className="flex min-h-11 cursor-pointer items-start gap-3 p-4 sm:p-6">
        <input
          id="walk-up"
          type="checkbox"
          className="mt-0.5 h-5 w-5 shrink-0"
          checked={walkUp}
          disabled={loading}
          onChange={(e) => onChoose(e.target.checked)}
        />
        <div className="min-w-0">
          <span className="block text-sm font-medium">{WALK_UP_LABEL}</span>
          {/* A string literal, not JSX text, and it has to stay one: lizard's .tsx lexer
              desyncs on an odd number of bare apostrophes in JSX TEXT, and this sentence
              carries the file's odd one. Written as text here it swallows MyCodePage
              whole and `make complexity` reports a function nobody wrote. */}
          <p className="text-xs text-text-muted">
            {"Shows the code that works at any court, even when you have a booking coming up — for starting on a "
              + "free court now, or paying for someone else's time."}
          </p>
        </div>
      </label>
    </Card>
  );
}

/**
 * The offer a member should not have to go looking for.
 *
 * <p>
 * A booking code stops opening a door when its window closes, and at that point the
 * member is holding a code the door will refuse with the only alternative sitting behind
 * a checkbox further down the page labelled for a court errand. The page knows the window
 * has closed — it is a field in the response it is already rendering — so it says so and
 * offers the switch, rather than waiting to be found.
 * </p>
 *
 * <p>
 * Silent unless there is genuinely something better to offer: no door at this club, or a
 * member already holding an ident code, and this block does not exist.
 * </p>
 */
function DoorWindowClosed(props: { onUseMemberCode: () => void }) {
  return (
    <Card className="space-y-3 border-l-4 border-warning-strong bg-warning-soft">
      <p className="text-sm text-warning-strong">{BOOKING_DOOR_WINDOW_CLOSED}</p>
      <Button variant="primary" className="w-full sm:w-auto" onClick={props.onUseMemberCode}>
        {USE_MEMBER_CODE_INSTEAD}
      </Button>
    </Card>
  );
}

// --- the page -------------------------------------------------------------------

export default function MyCodePage() {
  // The code's own lifecycle — fetching, pacing, the pre-fetch, the not-rotated chase and
  // the barred dead end — is `useMemberCode`. None of it is about doors, and inline it
  // made this function a thirty-branch render that nobody could check by reading.
  const {
    qr, secondsLeft, loading, error, barred, walkUp, refetch, refetchAsync, chooseWalkUp,
  } = useMemberCode();

  // doors: member — one read carries the whole door picture, and every block it feeds is
  // silent unless this club has a door. See `doorFacts` below.
  const doorRead = useMemberDoor(true);
  const door = doorRead.door;
  /** Read ONCE, before the first fetch resolves, so a no-signal cold start paints something. */
  const [cached] = useState(() => readLastKnown());

  const { shown: shownDecision, dismiss } = useShownDecision(door, refetch);
  const { doorsClub, contact, meaning } = doorFacts(door, qr, cached);
  /** A decision is only ever about a door, so a club with none has none to show. */
  const decisionToShow = doorsClub ? shownDecision : null;

  /** Re-read at every instant the page has been told something changes at. D4. */
  useBoundaryRefresh(
    boundaryInstants(door, qr),
    useCallback(() => {
      void refetchAsync();
      void doorRead.refresh();
    }, [refetchAsync, doorRead]),
  );

  /**
   * Has this booking code stopped opening a door? Null when there is no window to judge.
   *
   * <p>
   * Read off the clock once a second like every other instant on this page, never counted
   * in ticks — a phone in a pocket fires none, and this is precisely the boundary a phone
   * sleeps through.
   * </p>
   */
  /** Zero when there is no code at all, which the checklist reads as "had run out". */
  const codeSecondsLeft = qr ? secondsLeft : 0;
  const doorWindowLeft = useCountdownSeconds(bookingDoorWindowEnd(qr));
  const bookingDoorWindowClosed = doorWindowLeft !== null && doorWindowLeft <= 0;

  // After every hook, so none is skipped. BarredCard says why it replaces the whole page.
  if (barred !== null) return <BarredCard reason={barred} error={error} loading={loading} onCheckAgain={refetch} />;

  // Every read has failed and there is nothing live to show — see OfflinePage.
  if (everythingFailed({ error, qr, doorFailed: doorRead.failed, doorsClub })) {
    return <OfflinePage cached={cached} contact={contact} loading={loading} onTryAgain={refetch} />;
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Your code</h1>
        <p className="text-sm text-text-secondary">{subtitleFor(doorsClub)}</p>
      </div>

      {decisionToShow && (
        <DecisionCard
          decision={decisionToShow}
          door={door}
          contact={contact}
          onRefreshCode={refetch}
          onDismiss={dismiss}
        />
      )}

      <CodeCard
        qr={qr}
        meaning={meaning}
        error={error}
        failure={doorRead.failure}
        contact={contact}
        loading={loading}
        secondsLeft={secondsLeft}
        onRefresh={refetch}
      />

      <DoorBlocks
        doorsClub={doorsClub}
        door={door}
        cached={cached}
        doorRead={doorRead}
        contact={contact}
        codeSecondsLeft={codeSecondsLeft}
        windowClosedOffer={bookingDoorWindowClosed && !walkUp}
        onUseMemberCode={() => chooseWalkUp(true)}
        onRefreshCode={refetchAsync}
      />

      {/* Below the QR now: a walk-up is a court concept, and it cost ~96px of the first
          screen at 360 — where what a member at a door came for is the code. */}
      <WalkUpSwitch walkUp={walkUp} loading={loading} onChoose={chooseWalkUp} />

      <DoorFooter doorsClub={doorsClub} contact={contact} />
    </div>
  );
}

/**
 * Everything on this page that exists only because the club has a door — and the one
 * sentence that covers the seconds before the page knows whether it has.
 *
 * <p>
 * Gathered out of the render for the reason the complexity gate exists. Four door blocks
 * guarded by three different conditions, inline among the court blocks, is a render where
 * the next one gets added to the wrong arm — and a page that says something about doors
 * at a club that has none is the single failure this whole surface is designed around.
 * One component, one guard, one place to check it.
 * </p>
 */
function DoorBlocks(props: {
  doorsClub: boolean;
  door: MemberDoor | null;
  cached: LastKnown;
  doorRead: ReturnType<typeof useMemberDoor>;
  contact: ContactKnowledge;
  codeSecondsLeft: number;
  /** Has the booking code on screen stopped opening a door, with a better one to offer? */
  windowClosedOffer: boolean;
  onUseMemberCode: () => void;
  onRefreshCode: () => Promise<void>;
}) {
  const { doorsClub, doorRead, windowClosedOffer, onUseMemberCode } = props;

  if (!doorsClub) {
    // D9. While the one read that answers "does this club even have a door" is still in
    // flight, the page used to render the court-only page with total confidence and then
    // grow a whole section under the member thumb four seconds later. Saying that a
    // question is being asked costs one muted line and claims nothing: the sentence is
    // true whichever way the answer comes back. See DOOR_SECTION_CHECKING.
    if (!doorRead.loading) return null;
    return <p className="text-sm text-text-muted">{DOOR_SECTION_CHECKING}</p>;
  }

  return (
    <>
      {/* Only when there is something better to switch TO. A member already on an ident
          code has nothing to offer, and a club with no door has no window to have closed. */}
      {windowClosedOffer && <DoorWindowClosed onUseMemberCode={onUseMemberCode} />}
      <DoorSection
        door={props.door}
        cached={props.cached}
        doorRead={doorRead}
        contact={props.contact}
        codeSecondsLeft={props.codeSecondsLeft}
        onRefreshCode={props.onRefreshCode}
      />
    </>
  );
}

/**
 * The two things at the foot of the page, both silent at a club with no door: the way to
 * the member own record, and the way to a human.
 */
function DoorFooter({ doorsClub, contact }: { doorsClub: boolean; contact: ContactKnowledge }) {
  if (!doorsClub) return null;
  return (
    <>
      {/* D14. The member own record was three steps away — avatar, Profile, scroll — from
          the screen where the question "did that actually work?" gets asked. */}
      <Link
        to={`/profile#${HISTORY_ANCHOR}`}
        className="inline-flex items-center min-h-11 text-sm text-accent-strong underline underline-offset-2 hover:no-underline"
      >
        {HISTORY_LINK_LABEL}
      </Link>
      <ClubContact contact={contact} />
    </>
  );
}

/**
 * The three door facts the page derives rather than reads.
 *
 * <p>
 * Out here because they are pure, because the reasoning behind the first one is longer
 * than the expression, and because a render that branches on eight optional chains is one
 * nobody can check by reading.
 * </p>
 *
 * <p>
 * <b>Does this club have a door at all?</b> The live answer wins outright, including when
 * it is `false` — a club that has just retired its gate must go silent. With no live
 * answer either fallback will do, and they are ORed rather than ranked: both are the same
 * claim from two different reads, and a member at a door is not served by the page
 * forgetting one of them.
 * </p>
 *
 * <p>
 * <b>The contact is where the same shape was WRONG, and one `??` chain hid it.</b> It
 * ended `?? { phone: null, email: null }`, so a read that never landed came out looking
 * exactly like a club that has set neither — and every surface downstream went on to
 * state the second as a fact to somebody standing outside a locked building. The three
 * states are now carried in the type rather than collapsed into two nulls, and the
 * last-known one keeps its age so it is offered as a number from earlier rather than as
 * the current one. See {@link ContactKnowledge}.
 * </p>
 */
function doorFacts(door: MemberDoor | null, qr: MyQrCode | null, cached: LastKnown) {
  const remembered = cached.door ?? null;
  let contact: ContactKnowledge = CONTACT_UNKNOWN;
  if (door) contact = liveContact(door.contact);
  else if (remembered) contact = staleContact(remembered.value.contact, minutesSince(remembered.savedAt));

  const standing = door ? describeStanding(door) : null;
  return {
    doorsClub: door ? door.doors : (qr?.doors === true || remembered?.value.doors === true),
    contact,
    // The de-duplication rule, stated once. See describeDoor.
    meaning: qr ? describeKind(qr, !!standing?.suppressesCodeClause) : null,
  };
}

/**
 * Every instant the page has been TOLD something changes at.
 *
 * <p>
 * Out here rather than inline for the reason `doorFacts` is: five optional chains in an
 * array literal is five branches the complexity gate counts against a render, and none of
 * them is a decision anybody needs to read while following what the page draws.
 * </p>
 *
 * <p>
 * BOTH reads are listed on purpose. The booking's end and both edges of its door window
 * come from `/me/door`; the booking code's own window comes from `/me/qr/generate`, which
 * is a different request and survives a `/me/door` that did not. A page that re-read only
 * the boundaries of the response that happened to land is a page that still shows a
 * finished booking's code when the other one failed.
 * </p>
 *
 * <p>
 * The code's own expiry is NOT here: `useMemberCode`'s pre-fetch already owns it, and two
 * things arming a fetch at the same instant is a double request at the exact moment a
 * member is holding the phone up.
 * </p>
 */
function boundaryInstants(door: MemberDoor | null, qr: MyQrCode | null): (string | null | undefined)[] {
  const booking = door?.next_booking ?? null;
  return [
    booking?.ends_at,
    booking?.door_opens_at,
    booking?.door_closes_at,
    qr?.door_opens_at,
    qr?.door_closes_at,
  ];
}

/** When the booking code on screen stops opening a door, or null if it never did. */
function bookingDoorWindowEnd(qr: MyQrCode | null): string | null {
  if (qr?.kind !== "booking") return null;
  return qr.door_closes_at ?? null;
}

/**
 * Has EVERY read failed, at a club that has a door to talk about?
 *
 * <p>
 * All four halves matter and the last one most: this decides whether the whole page is
 * replaced by {@link OfflinePage}, every sentence of which is about a door. At a club with
 * no gate — or one this page has never yet heard has one — the code card's own "Couldn't
 * get a code" is the right and complete answer.
 * </p>
 */
function everythingFailed(state: {
  error: string | null;
  qr: MyQrCode | null;
  doorFailed: boolean;
  doorsClub: boolean;
}): boolean {
  return !!state.error && !state.qr && state.doorFailed && state.doorsClub;
}

/**
 * The QR card — every behaviour it already had, plus one way to make it bigger.
 *
 * <p>
 * Extracted from the page for the reason the complexity gate exists: the page grew four
 * door blocks and a render that branches five ways is one nobody can check by reading.
 * Nothing about the code's own lifecycle moved with it.
 * </p>
 */
function CodeCard(props: {
  qr: MyQrCode | null;
  meaning: { headline: string; detail: string } | null;
  error: string | null;
  /** Which failure the door read hit, which is the best evidence of WHY a renewal failed. */
  failure: ReadFailure | null;
  contact: ContactKnowledge;
  loading: boolean;
  secondsLeft: number;
  onRefresh: () => void;
}) {
  const { qr, meaning, error, failure, contact, loading, secondsLeft, onRefresh } = props;
  // The overlay is this card's own state: it is the same symbol, bigger, and nothing
  // above needs to know it is open.
  const [full, setFull] = useState(false);
  /**
   * D5 — a code at zero is not a code, and no version of it may look scannable.
   *
   * <p>
   * It was drawn at forty per cent opacity under "Expired — refreshing", and forty per
   * cent is a QR that still decodes: a member with no signal held a dead code up to a
   * scanner in the dark, repeatedly, for minutes, while the screen promised a refresh that
   * could not happen. Opacity is decoration. A member owes a sentence.
   * </p>
   *
   * <p>
   * The symbol is REPLACED rather than dimmed, and the replacement forks on whether a
   * renewal is genuinely still in flight — "getting a fresh one" is only true while one is
   * being got. It stops being a transient the moment a fetch has come back empty-handed.
   * </p>
   */
  const dead = !!qr && secondsLeft === 0;
  const deadForGood = dead && !loading;
  return (
    <>
    <Card className="space-y-5">
      {error && !qr ? (
        <div className="space-y-3">
          <p className="text-sm text-danger-strong">{error}</p>
          <Button onClick={onRefresh} disabled={loading}>Try again</Button>
        </div>
      ) : !qr ? (
        <p className="text-sm text-text-secondary">Getting your code…</p>
      ) : (
        <>
          {dead ? (
            <div className="space-y-3 rounded-lg border border-danger-soft bg-danger-soft p-4 text-center">
              <p className="text-sm text-danger-strong">
                {deadForGood
                  ? codeExpiredDeadEnd(failure ?? "network", contact)
                  : "This code has run out. Getting a fresh one…"}
              </p>
              {deadForGood && (
                <Button variant="outline" className="w-full sm:w-auto" onClick={onRefresh}>Try again</Button>
              )}
            </div>
          ) : (
            <>
              {/* The whole symbol is the target. A scanner in a dark doorway wants area and
                  brightness before anything else, and a member holding a phone one-handed
                  should not have to find a small control to get them.

                  `max-w-[min(20rem,100%)]`, not `max-w-xs`. Tailwind's `xs` is 20rem, and a
                  rem is whatever the reader has set: at a root font of 32px it resolved to
                  640px inside a 360px phone, the symbol ran off both edges and the whole
                  page scrolled sideways. The `min()` keeps the 320px intent at a default
                  root and clamps to the column at any other. */}
              <button
                type="button"
                aria-label="Show your code full screen"
                onClick={() => setFull(true)}
                className="mx-auto block w-full max-w-[min(20rem,100%)]"
              >
                <QrSvg value={qr.code} className="w-full h-auto rounded-lg border border-border" />
              </button>
              <p className="text-center text-xs text-text-muted">{"⤢ Tap the code to fill the screen"}</p>
            </>
          )}

          <div className="text-center space-y-1">
            {/* `break-all` and `max-w-full`: twelve monospaced characters at 0.25em
                tracking measure ~490px once the root font is 32, which is wider than the
                phone the member is holding. A code that runs off the edge cannot be read
                back to the desk, and it was what dragged the whole page sideways. */}
            <p className="mx-auto max-w-full break-all font-mono text-2xl tracking-[0.25em]" aria-label="Your code">
              {qr.code}
            </p>
            <p className="text-base font-medium">{meaning!.headline}</p>
            <p className="text-sm text-text-secondary">{meaning!.detail}</p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-text-muted inline-flex items-center gap-1.5">
              <QrIcon size={14} />
              {/* Never "Expired — refreshing" while nothing is being refreshed. The dead
                  block above carries that state now, in a sentence. */}
              {secondsLeft > 0 ? `Refreshes in ${formatCountdown(secondsLeft)}` : loading ? "Refreshing…" : "Run out"}
            </p>
            {/* Was `h-9` — 36px, pinned by the UX wireframe and exempted by name in the
                e2e sweep. A reviewer found it anyway, one-handed in the dark, which is the
                answer to the wireframe: `Button`'s own `h-11` is the floor everything else
                on this page already meets. */}
            <Button
              variant="outline"
              className="px-3 text-xs"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw size={14} className={cn("mr-1", loading && "animate-spin motion-reduce:animate-none")} /> Refresh
            </Button>
          </div>
          {error && <p className="text-xs text-danger-strong">{error}</p>}
        </>
      )}
    </Card>
    {full && qr && !dead && (
      <FullScreenQr code={qr.code} onClose={() => setFull(false)}>
        <QrSvg value={qr.code} className="w-full h-full" />
      </FullScreenQr>
    )}
    </>
  );
}

/**
 * Every read has failed. What the page can honestly still say, and what it must not.
 *
 * <p>
 * This is the state the service worker cannot serve — `mayCache()` refuses `/api/` and
 * refuses any request carrying an `authorization` header, and both guards are right — so
 * it gets a page of its own rather than three cards each saying nothing. It is reached
 * only at a doors club: every sentence here is about a door, and a club with no gate, or
 * one this page has never yet heard has one, must stay silent about doors even when
 * everything has failed. There the code card's own "Couldn't get a code" is the right and
 * complete answer.
 * </p>
 *
 * <p>
 * Three arms, and the order between them is the design. A member at an `active_member`
 * club holding an ident code with no booking cannot get in, whatever the code's clock
 * says: an ident code lives about a minute, and a door that has also lost the network
 * decides from a roster of BOOKINGS and nothing else. That arm comes first and draws no
 * QR at all — showing a hopeful symbol to somebody in the dark is the cruellest thing
 * this page could do.
 * </p>
 *
 * <p>
 * A booking code that has not yet expired is the common case and is drawn, at reduced
 * opacity, with its age in words: it really will probably still work. An expired one, or
 * none at all, is the second arm and again draws nothing.
 * </p>
 */
function OfflinePage(props: {
  cached: LastKnown;
  contact: ContactKnowledge;
  loading: boolean;
  onTryAgain: () => void;
}) {
  const { cached, contact, loading, onTryAgain } = props;
  const code = cached.qr;
  // Read once, on mount, through a lazy initialiser: the clock is not pure to read in a
  // render, and this page has nothing that should make a dead code come back to life
  // halfway through somebody looking at it.
  const [live] = useState(() => !!code && Date.parse(code.value.expiresAt) > Date.now());
  const identDeadEnd = code?.value.kind === "ident"
    && cached.door?.value.policy === "active_member"
    && !cached.door?.value.next_booking;

  const sentence = identDeadEnd
    ? offlineIdentDeadEnd(contact)
    : live
      ? offlineWithCode({
        fetchedAtClock: formatStart(code!.savedAt),
        minutesAgo: minutesSince(code!.savedAt),
        kind: code!.value.kind,
      })
      : offlineNoCode(contact);

  const showQr = live && !identDeadEnd;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Your code</h1>
        {/* The DOORS subtitle, always: this page is only ever reached at a doors club,
            and the code card's own `doors` flag is unavailable here because the request
            that carries it is the one that failed. Telling a member standing at a door
            with no signal to go and find a court box is the whole of what this page
            exists to stop. */}
        <p className="text-sm text-text-secondary">{subtitleFor(true)}</p>
      </div>

      <Card className="space-y-5 border-l-4 border-warning-strong bg-warning-soft">
        <p className="text-sm text-warning-strong">{sentence}</p>
        <Button variant="outline" onClick={onTryAgain} disabled={loading}>Try again</Button>
      </Card>

      {showQr && (
        <Card className="space-y-5">
          {/* The reduced opacity IS the message, and the sentence above says so in words:
              colour and weight are never the only signal for anything on this page. This
              QR is still LIVE — that is the arm's precondition — so unlike the expired one
              it is meant to be scannable, and 60% is the most it can be dimmed and stay so.

              `min(20rem,100%)` for the reason the card above carries in full: `max-w-xs`
              is 20 REM, and a reader who has turned the root font up got a 640px symbol
              inside a 360px phone. */}
          <div className="mx-auto w-full max-w-[min(20rem,100%)] opacity-60">
            <QrSvg value={code!.value.code} className="w-full h-auto rounded-lg border border-border" />
          </div>
          <div className="text-center space-y-1">
            <p className="mx-auto max-w-full break-all font-mono text-2xl tracking-[0.25em]" aria-label="Your code">
              {code!.value.code}
            </p>
          </div>
        </Card>
      )}

      <ClubContact contact={contact} />
    </div>
  );
}
