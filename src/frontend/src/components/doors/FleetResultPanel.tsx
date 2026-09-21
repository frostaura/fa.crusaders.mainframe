import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Card } from "../Card";
import { Badge } from "../Button";
import { relative } from "../../lib/deviceLiveness";
import {
  UNNAMED_GATE, doorConfirmedLine, doorExitIsMechanical, doorFleetNoChangeNotice,
  doorNotConfirmedLine, doorPowerLossLine, doorPowerLossUnknownFooter, doorsStayShutNotice,
} from "../../lib/gateCopy";
import { clubClock } from "../../lib/clubClock";
import { type FleetDoorResult } from "../../lib/api";

/** A result is a receipt for an instant, so it carries the instant it was taken at. */
export type FleetResultState = {
  action: "shut" | "reopen";
  /**
   * The CLUB's zone (E2 / R3-3), from the read that produced this result.
   *
   * `clubClock` falls back to the BROWSER's zone when given none — right for a volunteer
   * standing in the club, and wrong for anyone else, which is how a reviewer in Auckland
   * read a receipt dated on the wrong day beside a Door-events block that was correct.
   * Optional so a caller without a view still compiles; every caller in this tree passes it.
   */
  timezone?: string;
  doors: FleetDoorResult[];
  /** The doors this request deliberately did not touch, NAMED (C1). Never a silent omission. */
  leftShut: { id: string; name: string; gate_key: string | null }[];
  /** `Date.now()` at the moment the server answered — frozen, never re-read. */
  at: number;
};

/**
 * Was this door heard from recently enough to have got the change?
 *
 * <p>
 * Computed once, from the `last_seen_at` the SERVER reported at the moment it did the work,
 * against the result's own frozen instant. A panel left open for ten minutes must not drift
 * a "confirmed 12s ago" into "confirmed 10m ago" — this is a receipt, not a live view, and
 * the live view is the page above it.
 * </p>
 */
function confirmed(door: FleetDoorResult, at: number): boolean {
  if (!door.last_seen_at) return false;
  // `>` rather than `<`: a bare `<` in a .tsx file desyncs lizard's lexer into reading
  // a JSX tag that never closes. Same reason as the note in test/harness.tsx.
  return door.offline_after_seconds * 1000 > at - new Date(door.last_seen_at).getTime();
}

function heading(state: FleetResultState): string {
  const total = state.doors.length;
  const yes = state.doors.filter((d) => confirmed(d, state.at)).length;
  const verb = state.action === "shut" ? "shut" : "reopened";
  if (yes === total) return `${total} ${total === 1 ? "door" : "doors"} ${verb}`;
  return `${total} ${total === 1 ? "door" : "doors"} ${verb} — ${yes} confirmed, ${total - yes} not`;
}

function ResultRow({ door, state }: { door: FleetDoorResult; state: FleetResultState }) {
  const ok = confirmed(door, state.at);
  const clock = door.last_seen_at ? clubClock(door.last_seen_at, state.timezone) : null;
  return (
    <li className="border-t border-border py-3 first:border-t-0 sm:grid sm:grid-cols-[220px_minmax(0,1fr)_240px] sm:gap-4">
      <p className="min-w-0 break-words font-medium">
        {door.gate_key ?? `${door.name} (${UNNAMED_GATE})`}
        {" "}
        {/* Not colour alone: the words "confirmed" and "NOT CONFIRMED" are in the text. */}
        <Badge tone={ok ? "success" : "warning"}>{ok ? "confirmed" : "NOT CONFIRMED"}</Badge>
      </p>
      <p className="min-w-0 break-words text-sm text-text-secondary">
        {ok ? doorConfirmedLine(relative(door.last_seen_at, state.at)) : doorNotConfirmedLine(state.action, clock)}
      </p>
      <p className="text-sm text-text-secondary">{doorPowerLossLine(door.power_loss_behaviour)}</p>
    </li>
  );
}

/**
 * The per-door confirmation — W1.5's whole point, and the reason this is a screen.
 *
 * <p>
 * The server did the work at the server, atomically. Whether each DOOR knows is a separate
 * fact, and the only evidence for it is how recently that door called in. A result that said
 * "4 doors shut" and stopped would be true of the database and false of the corridor: a door
 * that has lost the network never hears the refusal and goes on admitting booked members from
 * a list it downloaded up to six hours ago.
 * </p>
 *
 * <p>
 * <b>Not confirmed is `warning`, not `danger`.</b> The action succeeded. What is unknown is
 * the door's knowledge of it, and rendering that as danger would say the shut failed — the
 * opposite of true.
 * </p>
 *
 * <p>
 * In page, beneath the control that produced it, rather than in a modal: `Modal` here is
 * `max-w-md` with no focus trap and no initial-focus move, and an eight-row result with a
 * heading inside it would mean fixing Modal, which is not this surface's change to make.
 * Focus moves to the heading so a keyboard user lands on the answer.
 * </p>
 */
export function FleetResultPanel({ state }: { state: FleetResultState }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, [state]);

  const anyUnknown = state.doors.some((d) => (d.power_loss_behaviour ?? "not_established") === "not_established");
  const taken = clubClock(state.at, state.timezone);

  const staying = doorsStayShutNotice(state.leftShut.map((d) => d.name));
  return (
    <Card className="mt-4 space-y-3">
      <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold">{heading(state)}</h3>
      <p className="text-xs text-text-muted">{taken}</p>
      {/* C1. A result that changed nothing used to print "0 doors reopened" and stop, which
          is the sentence that sent a reviewer looking for a broken endpoint. A zero-change
          result now never prints without the reason it was zero. */}
      {state.doors.length === 0 && (
        <p className="text-sm text-text-secondary">{doorFleetNoChangeNotice(state.action)}</p>
      )}
      <ul>
        {state.doors.map((door) => <ResultRow key={door.id} door={door} state={state} />)}
      </ul>
      {/* Named and linked, not counted: "1 door stayed shut" sends nobody anywhere. */}
      {staying && (
        <div className="space-y-1 border-t border-border pt-3">
          <p className="text-sm text-text-secondary">{staying}</p>
          <ul className="flex flex-wrap gap-2">
            {state.leftShut.map((door) => (
              <li key={door.id}>
                <Link
                  to={`/admin/doors/${door.id}`}
                  className="inline-flex min-h-11 items-center text-sm font-medium text-accent-strong underline"
                >
                  {door.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {anyUnknown && <p className="text-sm text-text-secondary">{doorPowerLossUnknownFooter()}</p>}
      <p className="border-t border-border pt-3 text-sm text-text-secondary">{doorExitIsMechanical()}</p>
    </Card>
  );
}
