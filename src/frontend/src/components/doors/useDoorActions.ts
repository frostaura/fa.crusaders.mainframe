import { useToast } from "../Toast";
import { doorStateNotice } from "../../lib/doorsCopy";
import { unnamedGateOfflineNotice } from "../../lib/gateCopy";
import { describeDeviceError } from "../../lib/deviceErrors";
import { doorEndpoints, endpoints, type AdminDoorDevice, type PowerLossBehaviour } from "../../lib/api";

/** Everything an admin can write about one door, in the one shape the one form sends. */
export type DoorFields = {
  name: string;
  gateKey: string;
  note: string;
  behaviour: PowerLossBehaviour;
};

/** Everything the door page can ask the API to do to one door. */
export type DoorActions = {
  /**
   * The whole door, in ONE PATCH. Returns whether the save went through, so the form knows
   * whether to close.
   *
   * <p>
   * A19: this used to be two calls behind two Edit buttons over four fields of one row —
   * and `PATCH /admin/devices/{id}` has always taken all four at once, so the split bought
   * nothing and cost an admin the ability to find the second half.
   * </p>
   */
  save: (fields: DoorFields) => Promise<boolean>;
  setEnabled: (enabled: boolean) => Promise<void>;
  remove: () => Promise<void>;
};

/**
 * The door page's mutations, kept out of the page so the page stays a loader and a layout.
 *
 * <p>
 * Every toast here reads from the SAME generator the screen renders — `doorStateNotice` for
 * the shut, `unnamedGateOfflineNotice` for a cleared name — because the toast is the half an
 * admin actually reads, the screen is behind it, and the court-box side of this product
 * shipped a round where the two said different things about one click.
 * </p>
 */
export function useDoorActions(
  door: AdminDoorDevice,
  context: { online: boolean; timezone: string; reload: () => Promise<void>; afterDelete: () => void },
): DoorActions {
  const toast = useToast();

  return {
    save: async ({ name, gateKey, note, behaviour }) => {
      try {
        // ONE request for all four fields. `gate_key` and `location_note` both bind
        // two-valued — `""` clears, absent leaves alone — which is why the form sends a
        // trimmed string for each rather than a null it thinks means "clear".
        await doorEndpoints.doorFieldsSave(door.id, {
          name, gate_key: gateKey, location_note: note, power_loss_behaviour: behaviour,
        });
        toast.push({
          tone: "success",
          // A cleared name is not a cosmetic loss: an unnamed door is sent an empty list, so
          // it stops working the moment it loses the network.
          text: gateKey === ""
            ? `${name} saved, and it has no door name. ${unnamedGateOfflineNotice()}`
            : `${name} saved. It is the ${gateKey} door, and it picks that up on its next heartbeat.`,
        });
        await context.reload();
        return true;
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not save that door."), durationMs: 8000 });
        return false;
      }
    },

    setEnabled: async (enabled) => {
      try {
        await endpoints.adminDeviceUpdate(door.id, { enabled });
        toast.push({
          tone: "success",
          text: enabled
            ? `${door.name} is open again. A door that can reach the club opens for members from its very next scan.`
            : `${door.name} is shut. ${doorStateNotice({ ...door, enabled: false }, context.online, context.timezone)}`,
          durationMs: 8000,
        });
        await context.reload();
      } catch (e) {
        toast.push({
          tone: "danger",
          text: describeDeviceError(e, enabled ? "Could not reopen that door." : "Could not shut that door."),
          durationMs: 8000,
        });
      }
    },

    remove: async () => {
      try {
        await endpoints.adminDeviceDelete(door.id);
        toast.push({
          tone: "success",
          text: `${door.name} deleted. It still has the club's key, so it re-registers on its next heartbeat as a new door with no name — unplug it if you meant to retire it.`,
          durationMs: 8000,
        });
        context.afterDelete();
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not delete that door.") });
      }
    },
  };
}
