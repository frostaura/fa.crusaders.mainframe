import { Alert } from "../Alert";
import { ConfirmButton } from "../ConfirmButton";
import {
  DOOR_REOPEN_LABEL, DOOR_SHUT_LABEL, doorReopenConfirm, doorShutConfirm,
  doorShutNotice, doorShutStandingNotice,
} from "../../lib/gateCopy";
import { type AdminDoorDevice } from "../../lib/api";

/**
 * Shut one door, or reopen it. One control, one copy source, two labels.
 *
 * <p>
 * <b>It is never disabled because the door is silent.</b> Shutting a deaf door is still the
 * right action at the server — the API refuses every scan at it from the instant the switch
 * is thrown — and a control greyed out for a door nobody can reach would be the screen
 * refusing to do a thing it can do. What is honest about a silent door is not a disabled
 * button but the notice above it, which states both halves, and the result line after it,
 * which says the door has not confirmed.
 * </p>
 *
 * <p>
 * The `ariaLabel` names the door. "Shut this door" repeats down a list of doors, and
 * `ConfirmButton`'s own doc comment is about exactly this: a visible label is often not a
 * name.
 * </p>
 */
export function DoorShutControl({ door, onDone, shutAt, online }: {
  door: AdminDoorDevice;
  onDone: (enabled: boolean) => Promise<void>;
  /** A club-time clock face for `out_of_service_since`, or null where the payload has none. */
  shutAt: string | null;
  /**
   * Whether this door is reporting right now.
   *
   * C5: the reopen confirm promised "from the very next scan" to every door, including one
   * nobody can reach — a promise about a machine that is not listening. It is the door's own
   * liveness that decides which half of the pair is true of THIS door today.
   */
  online: boolean;
}) {
  if (!door.enabled) {
    return (
      <div className="space-y-3">
        <Alert tone="danger">{doorShutStandingNotice(door.name, shutAt)}</Alert>
        {/* C2 / C5: shut AND not reporting are two facts and both are shown. A shut door
            nobody can reach has not heard the refusal and goes on admitting booked members
            from its cached list — the state the club-wide banner used to deny outright. */}
        {!online && (
          <p className="text-sm text-warning-strong">
            {`Nothing can reach ${door.name}, so it has not been told. It may still be admitting booked`
              + " members from the list it last downloaded, for up to six hours after its last call."}
          </p>
        )}
        <ConfirmButton
          idleLabel={DOOR_REOPEN_LABEL}
          confirmLabel={doorReopenConfirm(online)}
          ariaLabel={door.name}
          onConfirm={() => onDone(true)}
          className="min-h-11 w-full"
        />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {/* A14: the power-loss sentence used to be printed here AND on the door card directly
          above, twice on one screen. The card is where it belongs — it has the room to say
          it is a property of the lock and not of this app. */}
      <p className="text-sm text-text-secondary">{doorShutNotice()}</p>
      <ConfirmButton
        idleLabel={DOOR_SHUT_LABEL}
        confirmLabel={doorShutConfirm()}
        ariaLabel={door.name}
        onConfirm={() => onDone(false)}
        tone="danger"
        className="min-h-11 w-full"
      />
    </div>
  );
}
