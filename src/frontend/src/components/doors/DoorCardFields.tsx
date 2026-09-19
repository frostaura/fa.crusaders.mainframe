import { useId, useState } from "react";
import { Button, Input, Label } from "../Button";
import { describePowerLoss } from "../../lib/doorsCopy";
import { POWER_LOSS_BEHAVIOURS, type AdminDoorDevice, type PowerLossBehaviour } from "../../lib/api";

/** The API's own bound, on the field, so a long note is stopped where it is typed. */
export const LOCATION_NOTE_MAX_LENGTH = 200;

export const LOCATION_HINT = "Where somebody would physically find it — 'in the cupboard above the"
  + " fuse board, left of the front door'. The person reading this at six in the morning is not the"
  + " person who installed it.";

/**
 * <b>Never inferred, and the hint says so in the strongest terms the screen has.</b>
 *
 * An earlier version of this product derived the answer from the board's own settings and was
 * wrong. It is a property of the lock and its wiring; nothing in this software can change it,
 * and nothing in this software can see it.
 */
export const POWER_LOSS_HINT = "This is a property of the lock and its wiring, not of this app."
  + " Nothing here can change it, and it must never be guessed from the board's settings — an"
  + " earlier version of this product did exactly that and was wrong. Ask whoever fitted the lock.";

const POWER_LOSS_MEANINGS: Record<PowerLossBehaviour, string> = {
  not_established: "Nobody has checked. This is the honest answer until whoever fitted the lock says otherwise.",
  released: "The lock lets go when its power is cut. The door can be pushed open by anyone.",
  locked: "The lock stays locked when its power is cut. The relay changes nothing.",
};

/** The read view: what an admin walking to the board needs, with both halves of every field. */
export function DoorCardRead({ door }: { door: AdminDoorDevice }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="font-medium">Where this board is</p>
        <p className="min-w-0 break-words text-text-secondary">
          {door.location_note
            ? door.location_note
            : `Nobody has written down where this board is. ${LOCATION_HINT}`}
        </p>
      </div>
      <div>
        <p className="font-medium">With no power, this door is</p>
        <p className="text-text-secondary">{describePowerLoss(door.power_loss_behaviour)}</p>
        <p className="text-xs text-text-muted">{POWER_LOSS_HINT}</p>
      </div>
    </div>
  );
}

/**
 * The editor. A radio group rather than a select, because all three answers must be visible
 * at once and the default is a real answer rather than a placeholder an admin skips past.
 */
export function DoorCardEditor({ door, onSave, onClose }: {
  door: AdminDoorDevice;
  onSave: (note: string, behaviour: PowerLossBehaviour) => Promise<boolean>;
  onClose: () => void;
}) {
  const [note, setNote] = useState(door.location_note ?? "");
  const [behaviour, setBehaviour] = useState<PowerLossBehaviour>(door.power_loss_behaviour ?? "not_established");
  const [saving, setSaving] = useState(false);
  const noteId = useId();
  const hintId = `${noteId}-hint`;
  const groupId = `${noteId}-power`;

  const save = async () => {
    setSaving(true);
    try {
      // Trimmed here as well as at the API, so the row that comes back is the row the admin
      // will see. An empty field goes as `""`, which is the API's clear.
      if (await onSave(note.trim(), behaviour)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor={noteId}>Where this board is</Label>
        <Input
          id={noteId}
          aria-describedby={hintId}
          value={note}
          maxLength={LOCATION_NOTE_MAX_LENGTH}
          onChange={(e) => setNote(e.target.value)}
          placeholder="In the cupboard above the fuse board"
          disabled={saving}
        />
        <p id={hintId} className="mt-1 text-xs text-text-muted">{LOCATION_HINT}</p>
      </div>

      <fieldset aria-describedby={groupId}>
        <legend className="mb-1 block text-sm font-medium text-text-secondary">With no power, this door is</legend>
        <div className="space-y-2">
          {POWER_LOSS_BEHAVIOURS.map((value) => (
            <label key={value} className="flex min-h-11 items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${noteId}-power-loss`}
                className="mt-1 h-5 w-5"
                checked={behaviour === value}
                disabled={saving}
                onChange={() => setBehaviour(value)}
              />
              <span>
                <span className="block font-medium">{describePowerLoss(value)}</span>
                <span className="block text-text-secondary">{POWER_LOSS_MEANINGS[value]}</span>
              </span>
            </label>
          ))}
        </div>
        <p id={groupId} className="mt-1 text-xs text-text-muted">{POWER_LOSS_HINT}</p>
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save door card"}</Button>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}
