import { Link } from "react-router-dom";
import { Card } from "../Card";
import { Button } from "../Button";
import { cn } from "../../lib/utils";
import { formatClock, formatCountdown } from "../../lib/countdown";
import type { MemberDoor, MemberDoorDecision } from "../../lib/api";
import {
  DECISION_DISMISS,
  type DecisionAction,
  type DecisionTone,
  contactMissingNotice,
  decisionStamp,
  describeDecision,
} from "../../lib/memberDoorCopy";
import { spokenCountdown, useCountdownSeconds } from "./useCountdownSeconds";

/**
 * The member's own last door decision, as advice with one next action.
 *
 * <p>
 * <b>It sits above the QR</b>, which is the one piece of block order on this page worth
 * arguing about. A member who was just refused will hold the same code up again within
 * five seconds and be refused again. The reason is the answer; the QR is not.
 * </p>
 *
 * <p>
 * <b>It stays until it is superseded or dismissed.</b> Two minutes is the SERVER's fetch
 * window, not a display window: a card that vanishes mid-sentence while a cold member is
 * reading it is a defect, and on a five-second poll that boundary lands mid-read for
 * somebody. Absolute times throughout, never "just now" — a member who pocketed the phone
 * for ninety seconds cannot tell a fresh card from a stale one.
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
  onRefreshCode: () => void;
  onDismiss: () => void;
}) {
  const { decision, door, onRefreshCode, onDismiss } = props;
  const contact = door?.contact ?? { phone: null, email: null };
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

  const shared = {
    opensAtClock: opensAt ? formatClock(opensAt) : null,
    bookingStartsClock: door?.next_booking ? formatClock(door.next_booking.starts_at) : null,
    earlyEntryMinutes: door?.early_entry_minutes ?? 0,
    contact,
  };
  const copy = describeDecision(decision, { ...shared, countdown: seconds === null ? null : formatCountdown(seconds) });
  // The same sentence at whole-minute granularity, for the live region. A polite region
  // fed second-by-second digits is a screen reader reading numbers over a member's own
  // thoughts for as long as they stand there.
  const spoken = describeDecision(decision, { ...shared, countdown: seconds === null ? null : spokenCountdown(seconds) });

  const refresh = copy.actions.find((a) => a.kind === "refresh_the_code");

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
        */}
        <p className={cn("text-base font-medium", TONE_TEXT[copy.tone])} aria-hidden="true">{copy.headline}</p>
        <p className="sr-only">{spoken.headline}</p>
        <p className="text-sm text-text-secondary">{decisionStamp(decision.door_name, decision.at)}</p>
      </div>
      <p className="text-sm text-text-secondary">{copy.body}</p>
      {copy.actions.length === 0 && (decision.reason === "member_not_active" || decision.reason === "method_not_supported" || decision.reason === "not_a_gate") && (
        <p className="text-xs text-text-muted">{contactMissingNotice()}</p>
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
