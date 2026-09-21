import { useId, useState } from "react";
import { Button, Input, Label } from "../Button";
import { PowerLossChoice, LOCATION_HINT, LOCATION_NOTE_MAX_LENGTH } from "./DoorCardFields";
import { GATE_KEY_MAX_LENGTH, unnamedGateOfflineNotice } from "../../lib/gateCopy";
import { type AdminDoorDevice, type PowerLossBehaviour } from "../../lib/api";

/**
 * Everything an admin can write about one door, in ONE form with ONE Save.
 *
 * <p>
 * <b>Moved here from `pages/AdminDevices.tsx` (A2.5), not copied.</b> `/admin/doors` is now
 * the only place a gate is edited, named, shut, reopened or deleted, and Devices renders
 * gates as read-only rows. The reason is the one `lib/gateCopy.ts`'s own header records: the
 * out-of-service consequence had three call sites and shipped three rounds running with the
 * three of them disagreeing about what the click had just done. Two screens is two call
 * sites, and the fix is one screen rather than a shared component with two parents.
 * </p>
 *
 * <p>
 * <b>And now one FORM rather than two (A19).</b> The page carried two Edit buttons — "Edit
 * name and door name" under the controls and "Edit" on the door card — opening two forms
 * with two Saves over the same four fields of the same row. A reviewer under time pressure
 * edited one, saved, and could not find where the other field lived. All four go over a
 * single `PATCH /admin/devices/{id}`, so two saves were never anything but two chances to
 * finish half the job.
 * </p>
 *
 * <p>
 * There is no court list and no button map here, and their absence is the point rather than
 * an omission: the API refuses either on a Gate row outright, so an editor offering them
 * would be a form whose save can only fail.
 * </p>
 */
export function GateDetailsEditor({ device, onSave, onClose }: {
  device: AdminDoorDevice;
  /**
   * An empty key clears the door's name, and `""` is what the API reads as a clear — `null`
   * on that field means "leave it alone", which is what this used to send. `note` binds the
   * same two-valued way.
   */
  onSave: (fields: {
    name: string; gateKey: string; note: string; behaviour: PowerLossBehaviour;
  }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(device.name);
  const [key, setKey] = useState(device.gate_key ?? "");
  const [note, setNote] = useState(device.location_note ?? "");
  const [behaviour, setBehaviour] = useState<PowerLossBehaviour>(device.power_loss_behaviour ?? "not_established");
  const [saving, setSaving] = useState(false);
  const base = useId();
  const nameId = `${base}-name`;
  const keyId = `${base}-gate-key`;
  const keyHintId = `${base}-gate-key-hint`;
  const noteId = `${base}-note`;
  const noteHintId = `${base}-note-hint`;

  async function save() {
    // Trimmed here as well as on the API, so the row that comes back is the row the admin
    // will see — a key saved with a trailing space would render with an invisible difference
    // from the one they typed. An empty field goes as `""`, which is the API's clear; it used
    // to go as `null`, which the API discards.
    setSaving(true);
    try {
      const ok = await onSave({
        name: name.trim() || device.name, gateKey: key.trim(), note: note.trim(), behaviour,
      });
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor={nameId}>Name</Label>
        {/* C4: focus the FIRST field when the editor opens. The trigger that opened it is
            hidden rather than unmounted (see `DoorCardSection`), so without this a keyboard
            user is left on a control that is no longer visible and a screen-reader user hears
            nothing at all about a form that has just appeared. */}
        {/* autoFocus is deliberate: the editor is opened by an explicit press, which is
            exactly the case it is correct for. */}
        <Input
          id={nameId}
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Door gate"
          disabled={saving}
        />
      </div>
      <div>
        <Label htmlFor={keyId}>Door name</Label>
        {/* NOT "the only thing that tells one door from another": a gate decision is audited
            with the board's device code as well as its gate key, and the code is per board.
            What is true, and what an admin needs, is that the code is a fragment of a MAC
            address — so without a name here the record identifies the door by something
            nobody can match to a corridor without walking to it. */}
        <p id={keyHintId} className="mb-2 text-xs text-text-muted">
          Which door this board is on. Every door runs the same firmware and nothing is
          compiled in per door, so this is how the record names the door. Without it a
          scan is recorded against the board code alone. Leave it empty to take the name away
          again. {unnamedGateOfflineNotice()}
        </p>
        <Input
          id={keyId}
          aria-describedby={keyHintId}
          value={key}
          // The API's own bound, on the field, so a long name is stopped where it is typed
          // rather than after a save the admin has to decode.
          maxLength={GATE_KEY_MAX_LENGTH}
          onChange={(e) => setKey(e.target.value)}
          placeholder="front-door"
          disabled={saving}
        />
      </div>
      <div>
        <Label htmlFor={noteId}>Where this board is</Label>
        <Input
          id={noteId}
          aria-describedby={noteHintId}
          value={note}
          maxLength={LOCATION_NOTE_MAX_LENGTH}
          onChange={(e) => setNote(e.target.value)}
          placeholder="In the cupboard above the fuse board"
          disabled={saving}
        />
        <p id={noteHintId} className="mt-1 text-xs text-text-muted">{LOCATION_HINT}</p>
      </div>
      <PowerLossChoice value={behaviour} onChange={setBehaviour} disabled={saving} idBase={base} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save this door"}</Button>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}
