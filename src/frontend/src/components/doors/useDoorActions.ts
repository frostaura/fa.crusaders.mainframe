import { useToast } from "../toastContext";
import { doorDeletedNotice, doorDisplayName, doorStateNotice } from "../../lib/doorsCopy";
import { clubDayAndClock } from "../../lib/clubClock";
import { doorAlreadyNotice, unnamedGateOfflineNotice } from "../../lib/gateCopy";
import { describeDeviceError } from "../../lib/deviceErrors";
import { unsureSentence, writeOrReadBack } from "../../lib/lostReply";
import { LOST_REPLY, unsureWords } from "../../lib/lostReplyCopy";
import { markOwnDoorsAction } from "./useDoorsChrome";
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
  context: {
    online: boolean;
    timezone: string;
    reload: () => Promise<void>;
    /**
     * A-M7 / R3-14: it takes the CONFIRMATION with it.
     *
     * The toast was pushed and the page navigated in the same tick, so the confirmation for
     * the most destructive control on this surface was in practice invisible — an admin
     * arrived back at a list of doors with one fewer row and nothing saying the club had
     * done it, which on a page that also polls looks exactly like a board dropping off.
     */
    afterDelete: (said: string) => void;
  },
): DoorActions {
  const toast = useToast();
  // A11 / R3-21: ONE fallback for a door nobody has named. `door.name` is the registration
  // placeholder "Door gate", so every toast on this surface named every unnamed board in the
  // club identically while the heading above it said "Unnamed scanner (gate-44c103)".
  const name = doorDisplayName(door);

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
        // C11: this tab caused what the next read will find, so the banner states it
        // politely rather than interrupting the admin who just pressed the button.
        markOwnDoorsAction();
        /**
         * <b>B13 / R3-34 — a tab acts on a state that is hours old.</b>
         *
         * <p>
         * `unchanged: true` catches only the case where the door is already where this click
         * would put it. It cannot catch the other one: somebody else shut the door and
         * reopened it since this tab read, or this tab has been in the background all night
         * and the screen the admin is looking at is a photograph. The write then lands on a
         * door whose state nobody on this screen has seen, and the console reports success.
         * </p>
         *
         * <p>
         * The expectation is what the page last READ — which is `door.enabled`, the value the
         * control was rendered from and the value the admin acted on — so the server can
         * refuse with 409 `door_changed` rather than quietly winning. It is the negation of
         * the request by construction: a control offering "Shut" was rendered from an open
         * door.
         * </p>
         */
        const answer = await doorEndpoints.doorSetEnabled(door.id, enabled, door.enabled);
        /**
         * <b>B10 — a tab left open overnight "shut" a door somebody else had already shut,
         * and was told it had worked.</b>
         *
         * There is no conflict detection anywhere else on this surface, and this is where it
         * costs something: an admin learns that their click did a thing it did not do, and
         * the club has no way to discover from this screen that the door's state predates
         * them. WIRE-R2 §2 answers such a PATCH with `unchanged: true` and the CURRENT
         * `shut_by_name` / `out_of_service_since`, which is the only reason the sentence can
         * name anybody.
         */
        if (answer.unchanged) {
          toast.push({
            tone: "info",
            text: doorAlreadyNotice(
              name,
              !enabled,
              answer.shut_by_name ?? null,
              answer.out_of_service_since ? clubDayAndClock(answer.out_of_service_since, context.timezone) : null,
            ),
            durationMs: 8000,
          });
          await context.reload();
          return;
        }
        toast.push({
          tone: "success",
          text: enabled
            ? `${name} is open again. A door that can reach the club opens for members from its very next scan.`
            : `${name} is shut. ${doorStateNotice({ ...door, ...answer, enabled: false }, context.online, context.timezone) ?? ""}`,
          durationMs: 8000,
        });
        await context.reload();
      } catch (e) {
        toast.push({
          tone: "danger",
          text: describeDeviceError(e, enabled ? "Could not reopen that door." : "Could not shut that door."),
          durationMs: 8000,
        });
        // R3-34: a 409 means the door is not where this page thinks it is, so the next thing
        // the admin reads has to be the truth rather than the stale render they just acted
        // on. Re-read on every failure, not only on the conflict: a refusal is exactly when
        // a screen is least entitled to go on asserting what it was showing.
        await context.reload();
      }
    },

    remove: async () => {
      try {
        // C11: a deleted door leaves the shut set, which is a change this tab caused.
        markOwnDoorsAction();
        // FA-11: a lost reply is read back from the board list — gone means it was deleted.
        const { proven, answered } = await writeOrReadBack(
          async () => { await endpoints.adminDeviceDelete(door.id); return {}; },
          async () => ((await endpoints.adminDevicesList()).some((d) => d.id === door.id) ? null : {}),
        );
        // A-M7 / R3-14: the same sentence goes to the toast AND travels with the navigation,
        // because the navigation is what made the toast invisible. One generator, so the
        // two cannot say different things about one click — which is the lesson `gateCopy`'s
        // own header records.
        const said = proven ? LOST_REPLY.proven(doorDeletedNotice(name), answered) : doorDeletedNotice(name);
        toast.push({ tone: "success", text: said, durationMs: 8000 });
        context.afterDelete(said);
      } catch (e) {
        const unsure = unsureSentence(e, unsureWords(`${name} is still on Doors`, `${name} was deleted`, "Doors"));
        if (unsure) void context.reload();
        toast.push({ tone: "danger", text: unsure ?? describeDeviceError(e, "Could not delete that door.") });
      }
    },
  };
}
