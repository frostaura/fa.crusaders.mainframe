import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Card } from "../Card";
import { Button } from "../Button";
import { cn } from "../../lib/utils";
import {
  DIAGNOSIS_HEADING,
  DIAGNOSIS_HIDE,
  type DiagnosisInput,
  type DiagnosisRow,
  type DiagnosisState,
  USE_MEMBER_CODE_INSTEAD,
  buildDiagnosis,
} from "../../lib/memberDoorCopy";
import { CopySentence } from "./CopySentence";
import { MEMBER_DOOR_ACTION_LINK } from "./links";

/**
 * "The door didn't open" — the self-diagnosis, expanded in place.
 *
 * <p>
 * <b>Why it is a permanent control rather than something a refusal reveals.</b> Four of
 * the five refusal reasons can arrive by polling, because the code resolved to a member
 * before the door said no. `not_recognised` mostly cannot: an unknown, malformed or
 * another club's token names nobody, so there is no row this member's endpoint may
 * return, and the poll stays silent forever. That silence is the commonest dark-doorway
 * case there is, and "never say no refusals found" is satisfied by saying nothing at all
 * — which is the same dead end wearing better manners.
 * </p>
 *
 * <p>
 * Never a modal. A member one-handed in the dark should not have to find a close button,
 * and the container takes focus when it opens so a screen-reader user lands on it instead
 * of hunting for it.
 * </p>
 */

/**
 * The glyph is decoration and the colour is emphasis; the WORD in the row's accessible
 * text is the state. `neutral` gets a dash in the muted colour for the reason it exists:
 * a tick is a claim, and a row with nothing to claim must not make one. See
 * `DiagnosisState`.
 */
const STATE_GLYPH: Record<DiagnosisState, string> = { passed: "✓", neutral: "–", attention: "⚠", failed: "✗" };
const STATE_COLOUR: Record<DiagnosisState, string> = {
  passed: "text-success-strong",
  neutral: "text-text-muted",
  attention: "text-warning-strong",
  failed: "text-danger-strong",
};

/**
 * One row: a glyph, what is being checked, and what this screen found.
 *
 * <p>
 * <b>Stacked below `sm`, side by side above it.</b> Three items on a baseline row at
 * 360px put a wrapping label next to a wrapping value, and the result — photographed
 * during the visual pass — read "You nothing on file, and nothing barring you
 * membership": two sentences interleaved line by line, which is not a sentence at all.
 * Long values made it worse, and this lane has just added several, because a row that
 * declines to score itself has to say why in words.
 * </p>
 *
 * <p>
 * The glyph stays beside the label at every width; it is the label's own mark, and
 * floating it above a two-line block loses what it belongs to.
 * </p>
 */
function Row({ row }: { row: DiagnosisRow }) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5 text-sm sm:flex-row sm:items-baseline sm:gap-2">
      <span className="flex items-baseline gap-2">
        {/* The glyph is decoration. The row's accessible text carries the state as a WORD,
            because colour is never the only signal — and a tick and a cross are a colour
            for a great many people. */}
        <span aria-hidden="true" className={cn("shrink-0", STATE_COLOUR[row.state])}>{STATE_GLYPH[row.state]}</span>
        <span>{row.label}</span>
      </span>
      <span className="pl-6 text-text-secondary sm:flex-1 sm:pl-0 sm:text-right">{row.value}</span>
      <span className="sr-only">— {row.stateWord}</span>
    </li>
  );
}

export function SelfDiagnosis(props: {
  input: DiagnosisInput;
  busy: boolean;
  onHide: () => void;
  /** Switches the page to the member's own code, when the club's rule would admit it. E-H2 (3). */
  onUseMemberCode?: () => void;
}) {
  const { input, busy, onHide, onUseMemberCode } = props;
  const container = useRef<HTMLDivElement | null>(null);
  useEffect(() => { container.current?.focus(); }, []);

  const { rows, conclusion } = buildDiagnosis(input);

  return (
    // The focusable wrapper is a plain div rather than the Card: `Card` is a bare
    // function component that spreads HTMLAttributes, and a ref is not one of those.
    <div ref={container} tabIndex={-1} role="group" aria-label={DIAGNOSIS_HEADING}>
    <Card className="space-y-3">
      <h2 className="text-base font-medium">{DIAGNOSIS_HEADING}</h2>
      {busy ? (
        // The checklist renders AFTER both reads settle, so it never reports a stale tick.
        <p className="text-sm text-text-secondary">Checking…</p>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {rows.map((row) => <Row key={row.key} row={row} />)}
          </ul>
          {/* D13: the club's number in here is a link, exactly as it is in the footer. */}
          <CopySentence sentence={conclusion} className="border-t border-border pt-3 text-sm" />
          <div className="flex flex-col sm:flex-row gap-3">
            {/* E-H2 (3). The one thing on this phone that might work where the code on
                screen did not, offered where the member is already looking for an answer
                rather than behind a checkbox further down the page. */}
            {input.offerMemberCode && onUseMemberCode && (
              <Button variant="primary" className="w-full sm:w-auto" onClick={onUseMemberCode}>
                {USE_MEMBER_CODE_INSTEAD}
              </Button>
            )}
            {input.policy === "booking_window" && !input.hasBooking && (
              <Link to="/bookings" className={MEMBER_DOOR_ACTION_LINK}>
                Book a court
              </Link>
            )}
            <Button variant="outline" className="w-full sm:w-auto" onClick={onHide}>{DIAGNOSIS_HIDE}</Button>
          </div>
        </>
      )}
    </Card>
    </div>
  );
}
