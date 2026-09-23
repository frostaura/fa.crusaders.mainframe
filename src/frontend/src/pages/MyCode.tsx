import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { QrCode as QrIcon, RefreshCw } from "lucide-react";
import { type MemberDoor, type MemberDoorsShut, type MyQrCode } from "../lib/api";
import { formatCountdown } from "../lib/countdown";
import { clubClock } from "../lib/clubClock";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { cn } from "../lib/utils";
// doors: member
import { type LastKnown, type LastKnownQr, minutesSince, readLastKnown } from "../lib/lastKnown";
import {
  BOOKING_CODE_TAB,
  BOOKING_DOOR_WINDOW_CLOSED,
  CLUB_TIME_NOTE,
  CODE_CHOICE_STICKY,
  CODE_TABS_LABEL,
  MEMBER_CODE_TAB,
  NO_BOOKING_CODE_REASON,
  CONTACT_UNKNOWN,
  type CodeOnScreen,
  type ContactKnowledge,
  DOOR_SECTION_CHECKING,
  HISTORY_ANCHOR,
  HISTORY_LINK_LABEL,
  type ReadFailure,
  USE_MEMBER_CODE_INSTEAD,
  codeExpiredDeadEnd,
  decisionActionKinds,
  describeStanding,
  liveContact,
  offlineIdentDeadEnd,
  offlineNoCode,
  offlineWithCode,
  staleContact,
} from "../lib/memberDoorCopy";
import { ClubContact } from "../components/member-door/ClubContact";
import { MEMBER_DOOR_LINK_TAPPABLE } from "../components/member-door/links";
import { QrSvg } from "../components/member-door/QrSvg";
import { CopySentence } from "../components/member-door/CopySentence";
import { DecisionCard } from "../components/member-door/DecisionCard";
import { FullScreenQr } from "../components/member-door/FullScreenQr";
import { DoorSection } from "../components/member-door/DoorSection";
import { useBoundaryRefresh } from "../components/member-door/useBoundaryRefresh";
import { useCountdownSeconds } from "../components/member-door/useCountdownSeconds";
import { useMemberCode } from "../components/member-door/useMemberCode";
import { useMemberDoor, useShownDecision } from "../components/member-door/useMemberDoor";
import { SegmentedTabs } from "../components/SegmentedTabs";
// item 16 — the pushed card about the booking in hand, and the way to the whole guide.
import { WhatsNextCard } from "../components/onboarding/WhatsNextCard";
import { GUIDE_FROM_CODE, GUIDE_PATH } from "../lib/onboardingCopy";

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

/**
 * How wide the inline QR is — D7, and every length in it is deliberate.
 *
 * <p>
 * <b>The defect: the symbol got SMALLER as the reader's text got bigger.</b> Measured at
 * 320 px with a 32 px root font it came out at 190 px against 254 px at the default, because
 * every container between it and the viewport pads in `rem`: the page column's `px-4`, then
 * the card's `p-4`, each doubling as the root grew. A member who has turned the type up has
 * done so because reading is hard, and the product answered by shrinking the one thing on
 * the page that is not text.
 * </p>
 *
 * <p>
 * <b>The first fix reached past the card and overshot it.</b> Writing the width as
 * `min(100vw - 64px, 20rem)` made the symbol root-invariant by subtracting the page gutter
 * and the card padding as they measure AT THE DEFAULT ROOT — but the page gutter is
 * `Layout`'s `px-4`, it is rem, and at a 32 px root it is 32 px a side rather than 16. The
 * symbol then wanted 296 px inside a card that had 262 px to give, the card's min-content
 * width dragged the whole page column 34 px wider than its parent, and the card's right edge
 * went off the glass. A length that guesses at another component's padding is wrong twice:
 * once here, and again the day that component changes it.
 * </p>
 *
 * <p>
 * <b>So the symbol takes the card's inner width, and the CARD is what is pinned.</b> See
 * {@link CODE_CARD_BOX}. The two lengths below are then the only two that matter — fill
 * what the card has, up to the size a scanner needs at arm's length — and neither can drift
 * when a padding, a gutter or a breakpoint elsewhere moves.
 * </p>
 */
/**
 * <b>R3-29 (D-M2) adds the second bound, and it is a HEIGHT.</b>
 *
 * <p>
 * At 320×568 the scrollport is 458px. A 288px square, its tap hint and the twelve characters
 * under it put the readable code — the fallback a member reads back to the desk when the
 * scanner will not take the symbol — and the "which code is this" label below the fold, on
 * the one screen whose entire purpose is to be looked at. `min()` against a fraction of the
 * viewport height is what keeps the whole of the code card's identity block on the glass at
 * a short viewport while changing nothing at all at 844px, where `46vh` is 388 and the
 * 320px ceiling still binds.
 * </p>
 *
 * <p>
 * It costs nothing at a scanner: the inline symbol is the preview, and the full-screen
 * overlay — which is bounded by the viewport in both directions and reserves its column
 * exactly — is what a member holds up.
 * </p>
 */
const QR_WIDTH = "w-full max-w-[min(320px,46vh)]";

/**
 * The code card's own width and padding, in PIXELS. D7's other half.
 *
 * <p>
 * `Card`'s own `p-4 sm:p-6` is the right default everywhere else in the product. On this one
 * card it is what ate 64 px of a 320 px screen at a 32 px root — padding around a QR code is
 * not type and has no reason to scale with it.
 * </p>
 *
 * <p>
 * <b>Below `sm` the card sizes itself from the viewport, which is what makes the symbol
 * root-invariant.</b> `100vw - 32px` is a 16 px gutter a side that does not grow with the
 * root, and `354px` is that same card at its ceiling — 320 px of symbol, 16 px of padding a
 * side and the 1 px border. When the reader's root font makes the page gutter wider than
 * 16 px the card is wider than the column's content box, the column takes its min-content
 * width, and the card lands hard against the gutter instead of inside it. That is the
 * intended outcome: the gutter is whitespace, and the symbol is the page.
 * </p>
 *
 * <p>
 * From `sm` up the card fills the column as every other card does, because there the 320 px
 * ceiling is doing the bounding and a card narrower than its neighbours would be a visible
 * change to a layout no finding complained about.
 * </p>
 */
const CODE_CARD_BOX = "w-[min(100vw-32px,354px)] sm:w-full p-[16px] sm:p-[24px]";

/**
 * One clock face for the whole product, in `lib/clubClock.ts` — not a second `Intl`
 * formatter here. A hand-built sibling is what this repo already found once, disagreeing
 * with its twin about midnight; O1 found the second, subtler one, where the member surfaces
 * wrote the viewer's zone and the admin ones the club's.
 *
 * <p>
 * The zone is threaded through because `/me/door` now carries it (WIRE-R2 §4). Undefined —
 * the club has not answered yet — falls back to the browser's, which for a member standing
 * in the club is the same zone; what is never done is to guess a named one.
 * </p>
 */
function formatStart(instant: string, zone?: string): string {
  return clubClock(instant, zone);
}

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
function describeDoor(qr: MyQrCode, meaning: CodeMeaningInput): string {
  if (meaning.suppressed) return "";
  if (qr.doors !== true) return "";
  // B4 / E-H1. A club with doors shut is not a club with no doors, so the page does not go
  // silent — but this clause is the one place on the card that PROMISES, and a promise is
  // exactly what cannot be made about a door somebody has switched off. The standing line
  // below carries both halves of what a shut door does; this one stands down.
  if (meaning.doorsShut !== "none") return "";
  if (qr.kind !== "booking") return " It also opens the club door whenever the club's door rules allow.";
  if (!qr.door_opens_at) return "";
  const until = qr.door_closes_at ? formatStart(qr.door_closes_at, meaning.timezone) : null;
  const end = until ?? "shortly after your booking ends";
  // The reviewer read "from a few minutes before your slot" and "opens the club door from
  // 19:50" in one paragraph, over a booking at 22:00 — two hours and ten minutes apart,
  // with nothing to say the two windows are different things. The court's is fixed and the
  // door's is the club's own early-entry setting, and the sentence now says which is which
  // rather than leaving a member to decide the screen has contradicted itself.
  return ` The club's doors open earlier than its courts do: this code opens the club door from`
    + ` ${formatStart(qr.door_opens_at, meaning.timezone)} until ${end}.`;
}

/** What the card needs to know beyond the code itself to describe it truthfully. */
type CodeMeaningInput = {
  /** Is the standing line below already saying this, or better? See `describeDoor`. */
  suppressed: boolean;
  /** None, some or all of the club's doors are shut. B4. */
  doorsShut: MemberDoorsShut;
  /** The club's own zone, or undefined while the page has not been told it. O1. */
  timezone?: string;
  /** When the booking this code belongs to ends, when the page has been told. D4. */
  bookingEndsAt: string | null;
};

/**
 * A booking code's headline, in the tense the clock is actually in. D4.
 *
 * <p>
 * It read "Booking code · court 3 · starts 10:15" for the whole of a booking that had begun
 * at 10:15 — so a member glancing at the phone at 10:40, mid-game, was told their court
 * starts in the past. A heading in the wrong tense is read as the wrong booking.
 * </p>
 *
 * <p>
 * The end time comes from `/me/door`'s `next_booking` and only when it is the SAME booking
 * this code is for, matched on its start. A code's own `door_closes_at` is the booking's end
 * PLUS the club's grace window, so printing it as "ends" would tell a member their court
 * runs a quarter of an hour longer than it does.
 * </p>
 */
function bookingWhen(qr: MyQrCode, meaning: CodeMeaningInput): string {
  if (!qr.starts_at) return "";
  const startsAt = Date.parse(qr.starts_at);
  if (Number.isNaN(startsAt) || startsAt > Date.now()) {
    return ` · starts ${formatStart(qr.starts_at, meaning.timezone)}`;
  }
  const ends = meaning.bookingEndsAt ? ` · ends ${formatStart(meaning.bookingEndsAt, meaning.timezone)}` : "";
  return ` · on now${ends}`;
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
/**
 * Does this card put a clock face in front of the member?
 *
 * <p>
 * Asked of the rendered sentences rather than of the code's kind, because the clocks come
 * from three places — the booking's start, its end, and the door window — under conditions
 * that do not line up with booking-versus-ident. Reading the strings the card is about to
 * draw is not a heuristic here: "is there a time on this card" is literally the question,
 * and it stays right when a fourth clock is added to one of those sentences.
 * </p>
 */
function showsAClock(meaning: { headline: string; detail: string }): boolean {
  return /\d{1,2}:\d{2}/.test(`${meaning.headline} ${meaning.detail}`);
}

function describeKind(qr: MyQrCode, meaning: CodeMeaningInput): { headline: string; detail: string } {
  if (qr.kind === "booking") {
    const when = bookingWhen(qr, meaning);
    return {
      headline: qr.court_number != null ? `Booking code · court ${qr.court_number}${when}` : `Booking code${when}`,
      /*
        <b>R3-7 — "from a few minutes before your slot until it ends" is gone, and it was the
        only invented window on this page.</b> It sat a line above "it works at a door from
        18:05 until 20:50" for a court at 20:15: two windows, two hours and ten minutes
        apart, both introduced as what THIS code does, with nothing to say one was the
        court's and the other the door's. The reviewer read it as the screen contradicting
        itself, which is the right reading — a member cannot be expected to hold two
        different windows for one twelve-character string.

        The court's own activation window is not on this page's wire at all (the cue window
        is a tenant setting no member endpoint carries), so "a few minutes" was the page
        guessing. What the payload does carry is the DOOR window, exactly, and
        `describeDoor` states it once. A sentence that is true and silent about a number is
        better than a number nobody can reconcile.
      */
      detail: "For your booking only — it works at that court. At any other court it will not be recognised."
        + describeDoor(qr, meaning),
    };
  }
  return {
    /*
      Item 9 / D4 bug 5(a). This read "Walk-up code · any court" while the control that
      decided it said walk-up was OFF — measured on two accounts, and the commonest state
      there is: the server picks `ident` for a member with no booking, and the checkbox
      rendered off a separate flag. The headline now uses the same two words the selected
      tab does, so the page cannot name one thing twice and disagree with itself. "Walk-up"
      has not been lost — it is one of the two USES named in the sentence below, which is
      what the twenty-pixel checkbox was trying to say from two screens down.
    */
    headline: "Member code · any court",
    detail: "Identifies you at any court box: start on a free court now, or pay for someone else's time. "
      + "It is not tied to a booking." + describeDoor(qr, meaning),
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
 * A string from a function, not JSX text: lizard's .tsx lexer desyncs on an odd number of
 * bare apostrophes in JSX text, and the file already spends its odd one.
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

/** Which of the two codes a segment stands for. The wire has exactly these two kinds. */
type CodeTab = "booking" | "member";

const PANEL_ID: Record<CodeTab, string> = { booking: "panel-booking-code", member: "panel-member-code" };

/**
 * Does the club have a booking code to give this member right now — and the third answer.
 *
 * <p>
 * <b>It is derived from what the server has already said, never from an invented window.</b>
 * D4's design sketched "no booking starting in the next 2 hours"; that number is not on this
 * page's wire and would be the page guessing. What IS knowable: asking with no `kind` means
 * "you choose", so a server that chose `ident` has told us there is no booking code to show.
 * Asking for `ident` outright tells us nothing about bookings, so that case is `unknown` —
 * and `unknown` leaves the tab live, because the client's standing rule on this surface is to
 * fail towards OFFERING rather than towards hiding (`lib/scheduleGrid.ts` records why).
 * </p>
 */
function bookingCodeAvailable(qr: MyQrCode | null, memberChoice: boolean): "yes" | "no" | "unknown" {
  if (qr?.kind === "booking") return "yes";
  if (!memberChoice && qr?.kind === "ident") return "no";
  return "unknown";
}

/**
 * Item 9 — the code switch as a capsule tab control, and the fix for the contradiction.
 *
 * <p>
 * <b>The selected segment is derived from the code on the glass, not from a remembered
 * boolean.</b> That one change is the whole of D4's bug 5(a): the card headline read
 * "Walk-up code · any court" while the switch labelled "Walk up / pay for someone" was
 * unchecked — reproduced on two accounts — because `describeKind` rendered off `qr.kind`
 * and the switch rendered off a separate `walkUp` flag. Two sources of truth for one fact,
 * disagreeing in the commonest case there is: no booking, nothing chosen, server picks ident.
 * The member's PREFERENCE still exists and is still remembered — it is the argument to the
 * next fetch, not the state of the control.
 * </p>
 *
 * <p>
 * <b>Above the QR</b>, which is a real trade. The checkbox was deliberately moved below the
 * code because it cost ~96 px of the first screen; the capsule is about half that, and unlike
 * a checkbox it is the thing that SAYS which code you are holding, which belongs above the
 * code rather than under it. It was measured at y=1272 inside a 414 px scroller at 320x568 —
 * the last interactive thing on the page.
 * </p>
 */
function CodeChoice(props: {
  qr: MyQrCode | null;
  /** The member has asked for the member code outright, rather than letting the server pick. */
  memberChoice: boolean;
  onChoose: (next: boolean) => void;
  /** The code card. It IS the panel's content — see below. */
  children: React.ReactNode;
}) {
  const { qr, memberChoice, onChoose, children } = props;
  const selected: CodeTab = qr?.kind === "booking" ? "booking" : "member";
  const available = bookingCodeAvailable(qr, memberChoice);
  const bookingDisabled = available === "no";

  return (
    <div className="space-y-3">
      <SegmentedTabs<CodeTab>
        label={CODE_TABS_LABEL}
        value={selected}
        panelId={(v) => PANEL_ID[v]}
        onChange={(next) => onChoose(next === "member")}
        /*
          Drawn, not `sr-only`. This is the one place the two lanes that built the capsule
          disagreed, and the drawn sentence is why a member who taps the dim tab learns
          anything at all — see `showDisabledReasons` on the primitive.
        */
        showDisabledReasons
        segments={[
          {
            value: "booking",
            label: BOOKING_CODE_TAB,
            disabled: bookingDisabled,
            disabledReason: bookingDisabled ? NO_BOOKING_CODE_REASON : undefined,
          },
          { value: "member", label: MEMBER_CODE_TAB },
        ]}
      />
      {/*
        <b>The code card IS the panel, and that is what stops the page saying one thing
        twice.</b> The card's own sentence already names both uses of a member code — "start
        on a free court now, or pay for someone else's time" — so a panel that introduced the
        tab in its own words put two spellings of one fact forty pixels apart, which is the
        noise round 3 spent itself removing. `aria-controls` then points at the thing the tab
        actually governs rather than at a caption above it.

        No `tabIndex={0}`: the APG asks for it only on a panel with nothing focusable in it,
        and this one holds the full-screen control and the refresh.
      */}
      <div id={PANEL_ID[selected]} role="tabpanel" aria-labelledby={`segment-${PANEL_ID[selected]}`} className="space-y-2">
        {children}
        {selected === "member" && memberChoice && (
          <p className="text-xs text-text-muted">{CODE_CHOICE_STICKY}</p>
        )}
        {/*
          The REASON is the tablist's — it renders it under the segments, visibly, and points
          the dimmed tab's aria-describedby at it, so one sentence serves both readers. What
          belongs here is the way out of the state, which is a page concern.

          Deliberately NOT the bare "Book a court" the standing line offers under the
          booking-window rule: the two can appear on one screen, and two identical links a
          hundred pixels apart is a member wondering which one is which.
        */}
        {bookingDisabled && (
          <p className="text-xs text-text-muted">
            <Link to="/bookings" className="text-accent-strong underline underline-offset-2 hover:no-underline">
              Book a court to get one
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

/*
 * `WalkUpOnNotice` stood here — a card saying "You're on your member code, and will be for the
 * rest of this visit" with a "Back to your booking code" button, because R3-30 found that
 * "Use your member code instead" was a one-way door: three controls offered it and the only
 * way back was a checkbox two screens down labelled for a court errand.
 *
 * The tabs ARE the way back, they are at the top of the page, and they name both directions
 * — so the card described a mechanism that no longer exists. Its lifetime sentence lives in
 * the member-code panel (`CODE_CHOICE_STICKY`), where the member is already reading.
 */

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

/**
 * Everything `MyCodePage` KNOWS, gathered out of the function that draws it.
 *
 * <p>
 * <b>Extracted for the complexity gate, and the gate was right.</b> The page was eighteen
 * branches of derivation followed by three possible returns, and the derivation is the part
 * that is hard: a `null` that means "not read yet" three times over, a code's own countdown
 * crossed with a door's window, and a decision that is only a decision at a club with a door.
 * A reader checking whether the page draws the right thing had to hold all of it at once.
 * </p>
 *
 * <p>
 * <b>A hook rather than a pure function, because the facts are hooks.</b> Six of them, and the
 * rules of hooks mean they cannot move anywhere but into another hook. What this buys is that
 * the component below is now only a render: every question it asks is answered here, once,
 * with the reasoning beside the answer.
 * </p>
 */
function useMyCodePage() {
  // The code's own lifecycle — fetching, pacing, the pre-fetch, the not-rotated chase and
  // the barred dead end — is `useMemberCode`. None of it is about doors, and inline it
  // made this function a thirty-branch render that nobody could check by reading.
  const code_ = useMemberCode();
  const { qr, secondsLeft, loading, error, walkUp, refetch, refetchAsync, chooseWalkUp } = code_;

  // doors: member — one read carries the whole door picture, and every block it feeds is
  // silent unless this club has a door. See `doorFacts` below.
  const doorRead = useMemberDoor(true);
  const door = doorRead.door;
  /** Read ONCE, before the first fetch resolves, so a no-signal cold start paints something. */
  const [cached] = useState(() => readLastKnown());

  const { shown: shownDecision, dismiss } = useShownDecision(door, refetch);
  const facts = doorFacts(door, qr, cached, doorRead.failed && !!error);
  /** A decision is only ever about a door, so a club with none has none to show. */
  const decisionToShow = facts.doorsClub ? shownDecision : null;
  /**
   * D6 — when the door facts on screen were read, or null while they are the live answer.
   *
   * <p>
   * `useMemberDoor` keeps the last good answer through a failure, which is right. What is
   * not right is rendering it in the present tense afterwards with nothing to say how old it
   * is, which is what a member saw beside "this code has run out" with no signal.
   * </p>
   */
  const staleSince = door && doorRead.failure ? doorRead.readAt : null;
  const switchToMemberCode = useCallback(() => chooseWalkUp(true), [chooseWalkUp]);

  /** Re-read at every instant the page has been told something changes at. D4. */
  useBoundaryRefresh(
    boundaryInstants(door, qr),
    useCallback(() => {
      void refetchAsync();
      void doorRead.refresh();
    }, [refetchAsync, doorRead]),
  );

  /** Zero when there is no code at all, which the checklist reads as "had run out". */
  const codeSecondsLeft = qr ? secondsLeft : 0;
  /**
   * Has this booking code stopped opening a door? Null when there is no window to judge.
   *
   * <p>
   * Read off the clock once a second like every other instant on this page, never counted
   * in ticks — a phone in a pocket fires none, and this is precisely the boundary a phone
   * sleeps through.
   * </p>
   */
  const doorWindowLeft = useCountdownSeconds(bookingDoorWindowEnd(qr));
  const bookingDoorWindowClosed = doorWindowLeft !== null && doorWindowLeft <= 0;

  /*
    The decision card and the standing line are the same act seen from two sides — the card
    because the refusal reason wants a booking, the line because the club's policy does — and
    both were rendering "Book a court" as identical filled buttons on one screen. Asked
    through `decisionActionKinds`, which reads the same arm table the card renders from, so
    the answer cannot drift from the button it is about.
  */
  const bookingOfferedByCard = decisionToShow !== null
    && decisionActionKinds(decisionToShow).includes("book_a_court");

  return {
    ...code_,
    ...facts,
    doorRead,
    door,
    cached,
    dismiss,
    decisionToShow,
    staleSince,
    switchToMemberCode,
    codeSecondsLeft,
    bookingOfferedByCard,
    /** Only when there is something better to switch TO — see `DoorBlocks`. */
    windowClosedOffer: bookingDoorWindowClosed && !walkUp,
    /** The last usable code this browser saw, offered only once the live one has run out. */
    fallbackCode: codeSecondsLeft === 0 ? usableCachedBookingCode(cached, qr?.code ?? null) : null,
    loading,
    error,
    walkUp,
    refetch,
    refetchAsync,
    chooseWalkUp,
  };
}

// --- the page -------------------------------------------------------------------

export default function MyCodePage() {
  const {
    qr, secondsLeft, loading, error, barred, walkUp, refetch, refetchAsync, chooseWalkUp,
    doorsClub, doorsKnowledge, contact, meaning, code, doorRead, door, cached, dismiss,
    decisionToShow, staleSince, switchToMemberCode, codeSecondsLeft, bookingOfferedByCard,
    windowClosedOffer, fallbackCode,
  } = useMyCodePage();

  // After every hook, so none is skipped. BarredCard says why it replaces the whole page.
  if (barred !== null) return <BarredCard reason={barred} error={error} loading={loading} onCheckAgain={refetch} />;

  const doorBlocks = (
    <DoorBlocks
      actionOfferedAbove={bookingOfferedByCard}
      doorsClub={doorsClub}
      doorsKnowledge={doorsKnowledge}
      door={door}
      cached={cached}
      doorRead={doorRead}
      contact={contact}
      code={code}
      staleSince={staleSince}
      codeSecondsLeft={codeSecondsLeft}
      windowClosedOffer={windowClosedOffer}
      onUseMemberCode={switchToMemberCode}
      onRefreshCode={refetchAsync}
    />
  );
  const doorFooter = <DoorFooter doorsKnowledge={doorsKnowledge} contact={contact} />;

  // Every read has failed and there is nothing live to show — see OfflinePage.
  if (everythingFailed({ error, qr, doorFailed: doorRead.failed, doorsClub })) {
    return (
      <OfflinePage cached={cached} contact={contact} loading={loading} onTryAgain={refetch}>
        {/*
          D1 — the door section and the way to the member's own record are NOT the code
          read's dependants, and this page used to be where they both disappeared. Every
          sentence in here is already about a door; dropping the one block that states what
          this club's doors need, and the one link to what the club has recorded about this
          member, left the offline page saying less than it knew.
        */}
        {doorBlocks}
        {doorFooter}
      </OfflinePage>
    );
  }

  return (
    // R3-29: the pinned decision line is `position: fixed` at the bottom of the glass on a
    // phone, so the page owes it room. Without the padding the club's own number — the last
    // thing on the page and the thing a member outside a locked door reaches for — sits
    // underneath it.
    <div className={cn("max-w-xl mx-auto space-y-6", decisionToShow && "pb-24 sm:pb-0")}>
      {/*
        D8 — the code is the first thing in the page body, and everything that explains it
        comes after. It was a heading, a two-line subtitle and a decision card first, which
        at 320×568 put the QR entirely below the fold: a member at a scanner had to scroll to
        find the one thing they opened the page for. The heading stays — a page with no h1 is
        a page a screen-reader user cannot place — and it is one compact line.
      */}
      <h1 className="text-xl font-semibold">Your code</h1>

      {/*
        Item 9 — the capsule tabs, between the heading and the code. See `CodeChoice`: the
        selected segment is derived from the code on the glass, which is what stops the card
        headline and the control disagreeing, and it is the first thing after the heading
        because it is the thing that says WHICH code you are holding.
      */}
      <CodeChoice qr={qr} memberChoice={walkUp} onChoose={chooseWalkUp}>
        <CodeCard
          qr={qr}
          meaning={meaning}
          error={error}
          failure={doorRead.failure}
          contact={contact}
          loading={loading}
          secondsLeft={secondsLeft}
          fallback={fallbackCode}
          onRefresh={refetch}
        />
      </CodeChoice>

      {/*
        D10 — BELOW the code, not above it. A decision arriving used to push the QR down
        290 px on a screen somebody was holding against a scanner, and dismissing it pulled
        the QR back up again. Directly under the code is close enough to read without
        scrolling and cannot move it.

        R3-29 — and at 390×844 it was measured at y=829 against a 734px scrollport, which is
        95px below the fold: the most urgent thing on the page, invisible. It is PINNED
        rather than moved, because moving it back above the code re-opens D10 exactly.
        `DecisionPeek` is the pin.
      */}
      {decisionToShow && (
        <DecisionCard
          decision={decisionToShow}
          door={door}
          contact={contact}
          code={code}
          onRefreshCode={refetch}
          onDismiss={dismiss}
        />
      )}

      <p className="text-sm text-text-secondary">{subtitleFor(doorsClub)}</p>

      {/*
        Item 16, both halves, directly under the sentence that says what the code is FOR.

        The card is about the booking in hand and is the same component Home renders — one
        dismissal, one lifetime, two places a member might be standing when they need it. The
        link is the guide's second recall point, and it is the reason the three sentences in
        the guide about "if something does not work" are reachable from the screen where
        something is not working.
      */}
      <WhatsNextCard
        booking={door?.next_booking}
        timezone={door?.timezone}
        doors={doorsKnowledge}
      />
      <Link
        to={GUIDE_PATH}
        className={MEMBER_DOOR_LINK_TAPPABLE}
      >
        {GUIDE_FROM_CODE}
      </Link>

      {doorBlocks}

      {doorFooter}
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
  /** The decision card above is already offering "Book a court". See `StandingLine`. */
  actionOfferedAbove?: boolean;
  doorsClub: boolean;
  /** Yes, no, or — D1 — this page never found out. */
  doorsKnowledge: "yes" | "no" | "unknown";
  door: MemberDoor | null;
  cached: LastKnown;
  doorRead: ReturnType<typeof useMemberDoor>;
  contact: ContactKnowledge;
  code: CodeOnScreen | null;
  staleSince: string | null;
  codeSecondsLeft: number;
  /** Has the booking code on screen stopped opening a door, with a better one to offer? */
  windowClosedOffer: boolean;
  onUseMemberCode: () => void;
  onRefreshCode: () => Promise<void>;
}) {
  const { doorsClub, doorsKnowledge, doorRead, windowClosedOffer, onUseMemberCode } = props;

  // D1. "Unknown" renders the section, because the section's failed arm is where the
  // "couldn't check" sentence and the last-known contact live. Only a club the page has
  // been TOLD has no door goes silent.
  if (!doorsClub && doorsKnowledge !== "unknown") {
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
        code={props.code}
        staleSince={props.staleSince}
        codeSecondsLeft={props.codeSecondsLeft}
        onRefreshCode={props.onRefreshCode}
        onUseMemberCode={onUseMemberCode}
        actionOfferedAbove={props.actionOfferedAbove}
      />
    </>
  );
}

/**
 * The two things at the foot of the page: the way to the member's own record, and the way
 * to a human.
 *
 * <p>
 * <b>D1 — "unknown" is not "no".</b> Both used to be silent, so a page whose every read had
 * failed offered a member standing at a locked door no number, no address and no way to
 * their own history. The club's contact is the one thing on this page that is still worth
 * something from a cache, and it was the one thing the failure state dropped.
 * </p>
 */
function DoorFooter({ doorsKnowledge, contact }: { doorsKnowledge: "yes" | "no" | "unknown"; contact: ContactKnowledge }) {
  if (doorsKnowledge === "no") return null;
  return (
    <>
      {/* D14. The member own record was three steps away — avatar, Profile, scroll — from
          the screen where the question "did that actually work?" gets asked. */}
      <Link to={`/profile#${HISTORY_ANCHOR}`} className={MEMBER_DOOR_LINK_TAPPABLE}>
        {HISTORY_LINK_LABEL}
      </Link>
      <ClubContact contact={contact} />
    </>
  );
}

/**
 * The club's number, in THREE states rather than two nulls.
 *
 * <p>
 * The shape this replaced ended `?? { phone: null, email: null }`, so a read that never
 * landed came out looking exactly like a club that has set neither — and every surface
 * downstream went on to state the second as a fact to somebody standing outside a locked
 * building. A remembered number keeps its age, so it is offered as a number from earlier
 * rather than as the current one. See {@link ContactKnowledge}.
 * </p>
 */
function contactFrom(door: MemberDoor | null, remembered: LastKnown["door"]): ContactKnowledge {
  if (door) return liveContact(door.contact);
  if (remembered) return staleContact(remembered.value.contact, minutesSince(remembered.savedAt));
  return CONTACT_UNKNOWN;
}

/**
 * Does this club have a door at all — and D1's THIRD answer when nobody knows.
 *
 * <p>
 * The live answer wins outright, including when it is `false`: a club that has just retired
 * its gate must go silent. With no live answer either fallback will do, and they are ORed
 * rather than ranked — both are the same claim from two different reads, and a member at a
 * door is not served by the page forgetting one of them.
 * </p>
 *
 * <p>
 * <b>`unknown` is not `no`.</b> It is what the page has when every read has failed and
 * nothing was ever cached, and it used to be spelled `false` — which is an answer, and the
 * wrong one. A club this phone has never heard anything about is not a club with no door.
 * </p>
 */
function doorsKnowledgeOf(
  door: MemberDoor | null,
  qr: MyQrCode | null,
  remembered: LastKnown["door"],
  failed: boolean,
): "yes" | "no" | "unknown" {
  const known = door ? door.doors : (qr?.doors === true || remembered?.value.doors === true);
  if (known) return "yes";
  return failed ? "unknown" : "no";
}

/**
 * D4 — the end of the booking THIS code is for, and of no other.
 *
 * <p>
 * `next_booking` is the member's next one, which the moment a court has finished is a
 * different booking entirely: taking its end for the end of the code on screen is how a
 * card came to read "on now · ends" against a slot that was over.
 * </p>
 */
function bookingEndsAtFor(door: MemberDoor | null, qr: MyQrCode): string | null {
  const next = door?.next_booking;
  if (!next || next.starts_at !== qr.starts_at) return null;
  return next.ends_at;
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
 * <b>The contact is where the same shape was WRONG</b>, and it is {@link contactFrom}'s
 * now — along with {@link bookingEndsAtFor} and the one source both `doorsShut` and
 * `timezone` are read from. Each was an optional chain with a default on the end, inline
 * among six others, and together they took this function past the complexity gate: at
 * twenty-five branches in twenty-three lines, "a render nobody can check by reading" had
 * simply moved down here.
 * </p>
 */
function doorFacts(door: MemberDoor | null, qr: MyQrCode | null, cached: LastKnown, failed: boolean) {
  const remembered = cached.door ?? null;
  const contact = contactFrom(door, remembered);

  const standingSource = door ?? remembered?.value ?? null;
  const code = codeOnScreen(qr);
  const standing = standingSource ? describeStanding(standingSource, code) : null;
  const doorsKnowledge = doorsKnowledgeOf(door, qr, remembered, failed);
  /*
    One source for both of these, rather than the same `(door ?? remembered?.value)?.x ?? y`
    chain spelled out three times. It was spelled out three times, and two of the copies fed
    the standing sentences while the third fed the code card — which is how two halves of one
    screen come to disagree about whether the club has shut its doors.
  */
  const doorsShut = standingSource?.doors_shut ?? "none";
  const timezone = standingSource?.timezone;
  return {
    doorsKnowledge,
    doorsClub: doorsKnowledge === "yes",
    contact,
    code,
    doorsShut,
    timezone,
    // The de-duplication rule, stated once. See describeDoor.
    meaning: qr
      ? describeKind(qr, {
        suppressed: !!standing?.suppressesCodeClause,
        doorsShut,
        timezone,
        bookingEndsAt: bookingEndsAtFor(door, qr),
      })
      : null,
  };
}

/** Which of the member's two codes is on screen, in the shape the copy module reads. */
function codeOnScreen(qr: MyQrCode | null): CodeOnScreen | null {
  if (!qr) return null;
  return { kind: qr.kind, doorOpensAt: qr.door_opens_at ?? null, doorClosesAt: qr.door_closes_at ?? null };
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
 * A booking code the page still holds that has NOT run out. R3-8(b).
 *
 * <p>
 * <b>The asymmetry between the two codes is the whole of this.</b> An ident code lives about
 * a minute and rotates, so with no signal it dies and nothing can be done. A booking code is
 * minted with the booking and is a stable token until the slot ends plus the grace window —
 * it does not rotate, and the copy in the last-known store is byte-for-byte the code the door
 * would accept. So the sixty seconds that kill one leave the other perfectly good, and a
 * member whose ident code expired offline was being shown "there's nothing on this screen for
 * a door to read" while a working booking code sat in `localStorage`.
 * </p>
 *
 * <p>
 * Both edges are checked, and against the ABSOLUTE instant the store keeps rather than
 * against a lifetime — that is what {@link LastKnownQr.expiresAt} exists for. A code past its
 * expiry, or past its door window, is not offered: a hopeful QR in the dark is the one thing
 * this surface refuses to do. And it is never offered in place of a LIVE code, only in place
 * of a dead one.
 * </p>
 */
function usableCachedBookingCode(cached: LastKnown, deadCode: string | null): LastKnownQr | null {
  const stored = cached.qr;
  if (!stored || stored.value.kind !== "booking") return null;
  if (stored.value.code === deadCode) return null;
  const now = Date.now();
  if (!(Date.parse(stored.value.expiresAt) > now)) return null;
  const closes = stored.value.doorClosesAt ? Date.parse(stored.value.doorClosesAt) : null;
  if (closes !== null && !Number.isNaN(closes) && closes <= now) return null;
  return stored.value;
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
  /** R3-8(b) — a booking code from the last-known store that has NOT run out, or null. */
  fallback: LastKnownQr | null;
  onRefresh: () => void;
}) {
  const { qr, meaning, error, failure, contact, loading, secondsLeft, fallback, onRefresh } = props;
  // The overlay is this card's own state: it is the same symbol, bigger, and nothing
  // above needs to know it is open.
  const [full, setFull] = useState(false);
  /**
   * Where focus goes when the full-screen overlay closes. R3-10 (the MEM half).
   *
   * <p>
   * <b>Escape, Done and the hardware back button all left focus on `<body>`.</b> For a
   * keyboard user that is the top of the document: the next Tab starts from the skip link,
   * so closing the code threw away their place on the page. For a screen-reader user it is
   * worse — the dialog they were in vanished and nothing was announced in its place. Focus
   * belongs on the control that opened the overlay, which is where they were standing.
   * </p>
   */
  const trigger = useRef<HTMLButtonElement | null>(null);
  const wasFull = useRef(false);
  useEffect(() => {
    // Only on the true→false edge. Running on every render would steal focus from whatever
    // the member has since tabbed to, and running on mount would take it on first paint.
    if (wasFull.current && !full) trigger.current?.focus();
    wasFull.current = full;
  }, [full]);
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
  const deadSentence = codeExpiredDeadEnd(failure ?? "network", contact);
  return (
    <>
    <Card className={cn("space-y-5", CODE_CARD_BOX)}>
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
            <>
            <div className="space-y-3 rounded-lg border border-danger-soft bg-danger-soft p-4 text-center">
              {deadForGood ? (
                // D13: the club's number here is a link. This is the message a member reads
                // holding a dead code at a door in the dark — the single worst place in the
                // product to make somebody memorise a phone number.
                <CopySentence sentence={deadSentence} className="text-sm text-danger-strong" />
              ) : (
                <p className="text-sm text-danger-strong">This code has run out. Getting a fresh one…</p>
              )}
              {/*
                R3-8(c) — ONE retry, not two. The footer's Refresh is suppressed while this
                block is up (see below) and the loose `error` paragraph under the card is
                too: a member with no signal was reading "This code has run out and can't be
                renewed without signal… Try again", then "Run out · Refresh", then "Couldn't
                get a code — the club's system couldn't be reached. Check your connection and
                try again." Three sentences about one failure and two buttons that do the
                same thing.
              */}
              {deadForGood && (
                <Button variant="outline" className="w-full sm:w-auto" onClick={onRefresh}>Try again</Button>
              )}
            </div>
            {/* R3-8(b). A booking code does not rotate, so one still inside its window is a
                code a door really will take — and it was sitting in the store unread while
                the sentence above said there was nothing on this screen for a door. */}
            {fallback && <CachedBookingCode code={fallback} />}
            </>
          ) : (
            <>
              {/* The whole symbol is the target. A scanner in a dark doorway wants area and
                  brightness before anything else, and a member holding a phone one-handed
                  should not have to find a small control to get them.

                  The width is the card's inner width, and the CARD is pinned in pixels —
                  see QR_WIDTH and CODE_CARD_BOX for the measurements that made that
                  necessary. */}
              <button
                type="button"
                ref={trigger}
                aria-label="Show your code full screen"
                onClick={() => setFull(true)}
                className={cn("mx-auto block", QR_WIDTH)}
              >
                <QrSvg value={qr.code} className="w-full h-auto rounded-lg border border-border" />
              </button>
              {/* 14px, not 12. It is the hint that explains the one gesture on the page,
                  and at 12px a reviewer holding the phone at arm's length in a doorway did
                  not read it at all. */}
              <p className="text-center text-sm text-text-muted">{"⤢ Tap the code to fill the screen"}</p>
            </>
          )}

          {/*
            <b>Gone with the symbol when the code is dead, not just the QR.</b> The visual
            pass caught this: the dead block said "there's no code on this screen a door or
            a court box will take", and two centimetres below it the twelve characters were
            still set at `text-2xl`, with "Identifies you at any court box… It also opens
            the club door whenever the club's door rules allow" under them in the present
            tense. The fallback code is the SAME dead code in a form somebody can type at a
            desk, and its description is a promise about a code that has run out. Replacing
            the symbol and leaving its twin and its sales pitch is the D5 defect with an
            extra step.
          */}
          {!dead && (
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
              {/*
                Whose clock, said once, where a clock is actually shown.

                This card prints "starts 17:00", "on now · ends 17:45" and the door window,
                and said nothing about which zone any of them were in — the same gap the
                history list had, and the one O1 closed by making every face on this surface
                the CLUB's day. A member travelling, or on a phone that guessed its zone
                wrong, had no way to know that. The test is whether a clock face is on the
                card rather than which code it is: a booking code always carries one, an
                ident code at a club with door windows sometimes does, and a note about
                times on a card showing no time is noise.
              */}
              {showsAClock(meaning!) && (
                <p className="text-xs text-text-muted">{CLUB_TIME_NOTE}</p>
              )}
            </div>
          )}

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
                on this page already meets.

                R3-8(c): gone while the dead block is up, because that block has its own
                "Try again" and two buttons doing one thing, twelve pixels apart, is what a
                member with no signal was handed. */}
            {!deadForGood && (
              <Button
                variant="outline"
                className="px-3 text-xs"
                onClick={onRefresh}
                disabled={loading}
              >
                <RefreshCw size={14} className={cn("mr-1", loading && "animate-spin motion-reduce:animate-none")} /> Refresh
              </Button>
            )}
          </div>
          {/* R3-8(c): and the second sentence about the same failure. `deadSentence` above
              already says what went wrong AND whose fault it was, with the club's number as
              a link; this one repeated it in a fourteen-pixel grey. */}
          {error && !deadForGood && <p className="text-xs text-danger-strong">{error}</p>}
        </>
      )}
    </Card>
    {/*
      D12 — it stays open when the code dies, and says so.

      It used to be `qr && !dead`, so the overlay UNMOUNTED the moment the code ran out:
      a member holding the phone against a scanner in the dark had the screen go back to
      the page by itself, with no explanation, led by whatever card happened to be at the
      top. Closing is the member's gesture; the overlay's job when the code dies is to say
      that it has, in the place they are already looking.
    */}
    {full && qr && (
      <FullScreenQr
        code={qr.code}
        secondsLeft={secondsLeft}
        dead={dead}
        renewing={dead && loading}
        deadSentence={deadSentence}
        onTryAgain={onRefresh}
        onClose={() => setFull(false)}
      >
        <QrSvg value={qr.code} className="w-full h-full" />
      </FullScreenQr>
    )}
    </>
  );
}

/**
 * The booking code the page still holds, offered where the dead one was. R3-8(b).
 *
 * <p>
 * It is drawn at full strength rather than dimmed, and that is the point rather than an
 * oversight: unlike the offline page's cached ident code, this one is not a hopeful copy of
 * something that has probably expired. A booking code does not rotate and this one is inside
 * both of its own edges — see {@link usableCachedBookingCode} — so it is the code the door
 * would take, and dimming it would tell a member in the dark to distrust the one thing on
 * the screen that works.
 * </p>
 *
 * <p>
 * What it does NOT get is the full-screen gesture. That overlay is built around the live
 * code's own countdown, and a second path into it carrying a code from a different source is
 * two lifecycles in one control. The symbol here is the same size as the live one.
 * </p>
 */
function CachedBookingCode({ code }: { code: LastKnownQr }) {
  return (
    <div className="space-y-3 rounded-lg border border-success-soft bg-success-soft p-4">
      <p className="text-sm text-success-strong">
        {"Your booking code is still good, and it doesn't need the club to renew it. Hold this one up instead."}
      </p>
      <div className={cn("mx-auto", QR_WIDTH)}>
        <QrSvg value={code.code} className="w-full h-auto rounded-lg border border-border" />
      </div>
      <p className="mx-auto max-w-full break-all text-center font-mono text-2xl tracking-[0.25em]" aria-label="Your booking code">
        {code.code}
      </p>
    </div>
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
  /** D1 — the door section and the history link, which do not belong to the code read. */
  children?: React.ReactNode;
}) {
  const { cached, contact, loading, onTryAgain, children } = props;
  const code = cached.qr;
  // Read once, on mount, through a lazy initialiser: the clock is not pure to read in a
  // render, and this page has nothing that should make a dead code come back to life
  // halfway through somebody looking at it.
  const [live] = useState(() => !!code && Date.parse(code.value.expiresAt) > Date.now());
  const identDeadEnd = code?.value.kind === "ident"
    && cached.door?.value.policy === "active_member"
    && !cached.door?.value.next_booking;

  const zone = cached.door?.value.timezone;
  const sentence = identDeadEnd
    ? offlineIdentDeadEnd(contact)
    : live
      ? { text: offlineWithCode({
        fetchedAtClock: formatStart(code!.savedAt, zone),
        minutesAgo: minutesSince(code!.savedAt),
        kind: code!.value.kind,
      }), link: null, tail: "" }
      : offlineNoCode(contact);

  const showQr = live && !identDeadEnd;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      {/* D8 — the code first here too. A member with no signal is at a door by definition. */}
      <h1 className="text-xl font-semibold">Your code</h1>

      <Card className="space-y-5 border-l-4 border-warning-strong bg-warning-soft">
        {/* D13: the number in this sentence is a link, as it is everywhere else. */}
        <CopySentence sentence={sentence} className="text-sm text-warning-strong" />
        <Button variant="outline" onClick={onTryAgain} disabled={loading}>Try again</Button>
      </Card>

      {/* The DOORS subtitle, always — and below the code, per D8. This page is only ever
          reached at a doors club, and the code card's own `doors` flag is unavailable here
          because the request that carries it is the one that failed. Telling a member
          standing at a door with no signal to go and find a court box is the whole of what
          this page exists to stop. */}
      <p className="text-sm text-text-secondary">{subtitleFor(true)}</p>

      {showQr && (
        // D7 — the same px padding as the live card, for the same reason.
        <Card className={cn("space-y-5", CODE_CARD_BOX)}>
          {/* The reduced opacity IS the message, and the sentence above says so in words:
              colour and weight are never the only signal for anything on this page. This
              QR is still LIVE — that is the arm's precondition — so unlike the expired one
              it is meant to be scannable, and 60% is the most it can be dimmed and stay so.

              {QR_WIDTH} for the reason the card above carries in full — and it is the same
              constant rather than a second expression, because a member with no signal is
              exactly the member least able to work around a symbol that has shrunk. */}
          <div className={cn("mx-auto opacity-60", QR_WIDTH)}>
            <QrSvg value={code!.value.code} className="w-full h-auto rounded-lg border border-border" />
          </div>
          <div className="text-center space-y-1">
            <p className="mx-auto max-w-full break-all font-mono text-2xl tracking-[0.25em]" aria-label="Your code">
              {code!.value.code}
            </p>
          </div>
        </Card>
      )}

      {/*
        D1 — the door section, the history link and the club's contact, handed down by the
        page. Every sentence on this page is already about a door; the blocks that state
        what this club's doors need and what the club has recorded about this member do not
        belong to the code read, and this is where they used to disappear.

        The contact comes down with them rather than being rendered here as well: this page
        is only ever reached at a club the page KNOWS has doors, so `DoorFooter` always
        draws it, and a second copy was two places to keep one rule.
      */}
      {children}
    </div>
  );
}
