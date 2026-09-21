import { Link } from "react-router-dom";
import { Card } from "../Card";
import { Button } from "../Button";
import { cn } from "../../lib/utils";
import { formatCountdown } from "../../lib/countdown";
import { clubClock } from "../../lib/clubClock";
import type { MemberDoor, MemberDoorDecision } from "../../lib/api";
import {
  DECISION_COLLAPSE_AFTER_MINUTES,
  DECISION_DISMISS,
  type ContactKnowledge,
  type DecisionAction,
  type DecisionTone,
  contactMissingNotice,
  contactUnknownNotice,
  decisionAge,
  decisionStamp,
  describeDecision,
} from "../../lib/memberDoorCopy";
import { spokenCountdown, useCountdownSeconds, useMinutesSince } from "./useCountdownSeconds";

/**
 * The member's own last door decision, as advice with one next action.
 *
 * <p>
 * <b>It sits BELOW the code, and that reverses where it started.</b> The original argument
 * was that a member who was just refused will hold the same code up again within five
 * seconds, so the reason is the answer and the QR is not — which is true, and is not an
 * argument for putting it above. Measured at 320×568, a decision arriving moved the QR down
 * 290 px on a screen somebody was holding against a scanner, and dismissing it moved it back
 * up; the first thing on the page has to be the code, and nothing that comes and goes may
 * shift it (D8, D10). Directly under the code is close enough to read without scrolling and
 * costs the QR nothing.
 * </p>
 *
 * <p>
 * <b>It stays until it is superseded or dismissed — but it visibly ages.</b> Two minutes is
 * the SERVER's fetch window, not a display window: a card that vanishes mid-sentence while a
 * cold member is reading it is a defect. What A3.2 did not say, and D6 found, is that the
 * card then stayed at full size and full confidence for as long as the page was open — a
 * green "The lock released · 10:02" still the biggest thing on the screen twenty minutes
 * later, over a code that had since run out. So it carries its age, and after five minutes
 * it collapses to one line. Still dismissible at every size.
 * </p>
 */

const TONE_CHROME: Record<DecisionTone, string> = {
  success: "border-l-4 border-success-strong bg-success-soft",
  info: "border-l-4 border-info-strong bg-info-soft",
  warning: "border-l-4 border-warning-strong bg-warning-soft",
  danger: "border-l-4 border-danger-strong bg-danger-soft",
};

const TONE_TEXT: Record<DecisionTone, string> = {
  success: "text-success-strong",
  info: "text-info-strong",
  warning: "text-warning-strong",
  danger: "text-danger-strong",
};

function ActionControl({ action }: { action: DecisionAction; }) {
  if (action.kind === "book_a_court") {
    return (
      <Link
        to="/schedule"
        className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-sm font-medium bg-brand-strong text-brand-ink border border-brand-strong hover:bg-brand-strong/90 w-full sm:w-auto"
      >
        {action.label}
      </Link>
    );
  }
  if (action.kind === "refresh_the_code") return null;
  return (
    <a
      href={action.href}
      className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-sm font-medium bg-brand-strong text-brand-ink border border-brand-strong hover:bg-brand-strong/90 w-full sm:w-auto"
    >
      {action.label}
    </a>
  );
}

export function DecisionCard(props: {
  decision: MemberDoorDecision;
  door: MemberDoor | null;
  /**
   * What the PAGE knows about reaching the club, resolved once above this card.
   *
   * <p>
   * It used to read `door?.contact` and default to two nulls of its own, which meant a
   * card rendered beside a failed read told the member the club has no number — the same
   * defect, in a second place, with a second spelling of it to keep in step.
   * </p>
   */
  contact: ContactKnowledge;
  onRefreshCode: () => void;
  onDismiss: () => void;
}) {
  const { decision, door, contact, onRefreshCode, onDismiss } = props;
  /**
   * The countdown belongs to the DECISION, and falls back to the booking only when the
   * decision carried no instant of its own.
   *
   * <p>
   * <b>The fallback used to be the only source, and it could almost never fire.</b>
   * `too_early` means the booking's window has NOT opened, which is exactly the condition
   * under which `NextBookingAsync` returns null — so a member watching a too-early card
   * was shown a countdown drawn from a booking the same response had already declined to
   * send them. The endpoint now computes the instant itself, through
   * `BookingCodeWindow.DoorHorizonMinutes`, which is the function the DOOR decides with
   * and is built from three settings no member's API surface carries.
   * </p>
   *
   * <p>
   * The fallback is kept for the one case that remains: a response that predates
   * `opens_at`, where a booking whose window is open is the only clock the page has. It is
   * a floor, not the source — hence `??` on a null rather than a choice between two.
   * </p>
   */
  const opensAt = decision.opens_at ?? door?.next_booking?.door_opens_at ?? null;
  const seconds = useCountdownSeconds(decision.reason === "too_early" ? opensAt : null);
  const zone = door?.timezone;
  /** D6 — how long this card has been on screen, read off the clock once a minute. */
  const minutesOld = useMinutesSince(decision.at);
  const collapsed = minutesOld >= DECISION_COLLAPSE_AFTER_MINUTES;

  const shared = {
    opensAtClock: opensAt ? clubClock(opensAt, zone) : null,
    bookingStartsClock: door?.next_booking ? clubClock(door.next_booking.starts_at, zone) : null,
    // E-H3: null under every policy but `booking_window`, and the copy has a wordless arm
    // for it. Zero here would print "in the next 0 minutes" at a club that has no such rule.
    earlyEntryMinutes: door?.early_entry_minutes ?? null,
    contact,
  };
  const copy = describeDecision(decision, { ...shared, countdown: seconds === null ? null : formatCountdown(seconds) });
  // The same sentence at whole-minute granularity, for the live region. A polite region
  // fed second-by-second digits is a screen reader reading numbers over a member's own
  // thoughts for as long as they stand there.
  const spoken = describeDecision(decision, { ...shared, countdown: seconds === null ? null : spokenCountdown(seconds) });

  const refresh = copy.actions.find((a) => a.kind === "refresh_the_code");
  const stamp = `${decisionStamp(decision.door_name, decision.at, decision.delivered_at, zone)}`
    + ` · ${decisionAge(minutesOld)}`;

  if (collapsed) {
    /*
      D6, after five minutes. It is a record rather than news by then, and it was still the
      largest element on a page whose code had moved on without it. One line, its age on it,
      and the same Dismiss — a collapsed card a member cannot get rid of is worse than a big
      one they can.
    */
    return (
      <Card className={cn("flex flex-wrap items-center justify-between gap-2 py-2", TONE_CHROME[copy.tone])} role="status">
        <p className="text-sm">
          <span className={TONE_TEXT[copy.tone]}>{copy.headline}</span>{" "}
          <span className="text-text-muted">{stamp}</span>
        </p>
        <Button variant="outline" className="px-3 text-xs" onClick={onDismiss}>{DECISION_DISMISS}</Button>
      </Card>
    );
  }

  return (
    <Card
      className={cn("space-y-3", TONE_CHROME[copy.tone])}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div>
        {/*
          The visible line carries the ticking digits and is hidden from the accessibility
          tree; the sr-only twin beside it carries the same sentence with the minutes in
          words, so it only changes once a minute. This split IS the a11y contract.

          It is only a SPLIT when the two differ. On every arm with no countdown — which is
          six of the seven — they are the same string, so the card held two copies of one
          sentence inside an atomic live region and the reviewer heard "The lock released."
          twice. Where there is nothing to hide, nothing is hidden and there is one copy.
        */}
        {spoken.headline === copy.headline ? (
          <p className={cn("text-base font-medium", TONE_TEXT[copy.tone])}>{copy.headline}</p>
        ) : (
          <>
            <p className={cn("text-base font-medium", TONE_TEXT[copy.tone])} aria-hidden="true">{copy.headline}</p>
            <p className="sr-only">{spoken.headline}</p>
          </>
        )}
        {/* D6: the age travels with the stamp. A member who pocketed the phone for ninety
            seconds cannot tell a fresh card from a stale one off an absolute time alone. */}
        <p className="text-sm text-text-secondary">{stamp}</p>
      </div>
      <p className="text-sm text-text-secondary">{copy.body}</p>
      {copy.actions.length === 0 && (decision.reason === "member_not_active" || decision.reason === "method_not_supported" || decision.reason === "not_a_gate") && (
        // Three states here too: a club with nothing on file, and a page that could not
        // read what the club has, are not the same admission.
        <p className="text-xs text-text-muted">
          {contact.contact ? contactMissingNotice() : contactUnknownNotice()}
        </p>
      )}
      <div className="flex flex-col sm:flex-row gap-3">
        {copy.actions.map((action) => <ActionControl key={action.kind} action={action} />)}
        {refresh && (
          <Button variant="primary" className="w-full sm:w-auto" onClick={onRefreshCode}>{refresh.label}</Button>
        )}
        <Button variant="outline" className="w-full sm:w-auto" onClick={onDismiss}>{DECISION_DISMISS}</Button>
      </div>
    </Card>
  );
}
