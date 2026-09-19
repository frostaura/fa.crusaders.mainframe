import { useId, useState } from "react";
import { Button, Input, Label } from "../Button";
import { GATE_KEY_MAX_LENGTH, unnamedGateOfflineNotice } from "../../lib/gateCopy";
import { type AdminDoorDevice } from "../../lib/api";

/**
 * A door's name and its door name, saved together.
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
 * One save because it is one job: a gate arrives named "Door gate" with no key at all, so
 * both are wrong at the same moment and splitting them would be two saves and two chances to
 * finish half of it.
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
   * on that field means "leave it alone", which is what this used to send.
   */
  onSave: (name: string, gateKey: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(device.name);
  const [key, setKey] = useState(device.gate_key ?? "");
  const [saving, setSaving] = useState(false);
  const base = useId();
  const nameId = `${base}-name`;
  const keyId = `${base}-gate-key`;
  const keyHintId = `${base}-gate-key-hint`;

  async function save() {
    // Trimmed here as well as on the API, so the row that comes back is the row the admin
    // will see — a key saved with a trailing space would render with an invisible difference
    // from the one they typed. An empty field goes as `""`, which is the API's clear; it used
    // to go as `null`, which the API discards.
    setSaving(true);
    try {
      if (await onSave(name.trim() || device.name, key.trim())) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor={nameId}>Name</Label>
        <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="Door gate" disabled={saving} />
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
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save door"}</Button>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}
