import { Alert } from "../Alert";
import { ConfirmButton } from "../ConfirmButton";
import {
  DOOR_REOPEN_LABEL, DOOR_SHUT_LABEL, doorPowerLossLine, doorReopenConfirm, doorShutConfirm,
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
export function DoorShutControl({ door, onDone, shutAt }: {
  door: AdminDoorDevice;
  onDone: (enabled: boolean) => Promise<void>;
  /** A club-time clock face for `out_of_service_since`, or null where the payload has none. */
  shutAt: string | null;
}) {
  if (!door.enabled) {
    return (
      <div className="space-y-3">
        <Alert tone="danger">{doorShutStandingNotice(door.name, shutAt)}</Alert>
        <p className="text-sm text-text-secondary">{doorPowerLossLine(door.power_loss_behaviour ?? "not_established")}</p>
        <ConfirmButton
          idleLabel={DOOR_REOPEN_LABEL}
          confirmLabel={doorReopenConfirm()}
          ariaLabel={`Reopen ${door.name}`}
          onConfirm={() => onDone(true)}
          className="h-11 w-full"
        />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{doorShutNotice()}</p>
      <p className="text-sm text-text-secondary">{doorPowerLossLine(door.power_loss_behaviour ?? "not_established")}</p>
      <ConfirmButton
        idleLabel={DOOR_SHUT_LABEL}
        confirmLabel={doorShutConfirm()}
        ariaLabel={`Shut ${door.name}`}
        onConfirm={() => onDone(false)}
        tone="danger"
        className="h-11 w-full"
      />
    </div>
  );
}
