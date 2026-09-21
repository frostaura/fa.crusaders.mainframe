import { Link } from "react-router-dom";
import { Card } from "../Card";
import { Button } from "../Button";
import { DoorCardRead } from "./DoorCardFields";
import { GateDetailsEditor } from "./GateDetailsEditor";
import { UNNAMED_GATE } from "../../lib/gateCopy";
import { type AdminDoorDevice, type AdminSettings, type PowerLossBehaviour } from "../../lib/api";

/**
 * The door card, between the feed and the controls — because the person reading it is
 * usually about to walk to the board.
 *
 * <p>
 * <b>The page's ONE edit affordance (A19).</b> There used to be two — "Edit name and door
 * name" under the controls and "Edit" here — over four fields of one row that all travel on
 * one PATCH. A hurried reviewer edited through one and could not find where the other fields
 * lived. Everything writable about the door is now behind this button.
 * </p>
 */
export function DoorCardSection({ door, settings, editing, onEdit, onClose, onSave }: {
  door: AdminDoorDevice;
  settings: AdminSettings | null;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  onSave: (fields: {
    name: string; gateKey: string; note: string; behaviour: PowerLossBehaviour;
  }) => Promise<boolean>;
}) {
  return (
    <section aria-labelledby="door-card-heading" className="space-y-2">
      <h2 id="door-card-heading" className="text-lg font-semibold">Door card</h2>
      <Card className="space-y-4">
        {editing ? (
          <GateDetailsEditor device={door} onSave={onSave} onClose={onClose} />
        ) : (
          <>
            <DoorCardRead door={door} />
            <dl className="space-y-1 text-sm">
              <Fact label="Board" value={door.device_code} />
              <Fact label="MAC" value={door.mac_address ?? "not reported"} />
              <Fact label="Firmware" value={door.running_version ?? "not reported"} />
              <Fact label="Door name" value={door.gate_key ?? UNNAMED_GATE} />
            </dl>
            <ClubContact settings={settings} />
            <div className="flex flex-wrap gap-2">
              {/* The door's NAME in the accessible name: three "Manage"-shaped controls on
                  one admin's screen all reading "Edit" is reviewer B's repeated-link
                  finding one control along. */}
              <Button variant="outline" onClick={onEdit} aria-label={`Edit ${door.name}`}>
                Edit this door
              </Button>
              <Link
                to={`/admin/doors/${door.id}/card`}
                className="inline-flex min-h-11 items-center rounded-lg border border-control px-5 text-sm font-medium"
              >
                Print this door card
              </Link>
            </div>
          </>
        )}
      </Card>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <dt className="w-24 shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

/**
 * Both halves of the club contact.
 *
 * A door card with a blank where the phone number goes is a card that says nothing; one that
 * says nobody has set a contact, and where to set it, is a job. It is what a member sees when
 * a door turns them away, which is why it belongs on the card at all.
 */
function ClubContact({ settings }: { settings: AdminSettings | null }) {
  const parts = [settings?.club_contact_phone?.trim(), settings?.club_contact_email?.trim()]
    .filter((part) => part);
  if (parts.length > 0) {
    return <p className="text-sm"><span className="text-text-muted">Club contact</span> {parts.join(" · ")}</p>;
  }
  return (
    <p className="text-sm text-text-secondary">
      No club contact is set. Add one under{" "}
      <Link to="/admin/settings" className="text-accent-strong underline">Admin settings</Link>
      {" "}— it is what a member sees when a door turns them away.
    </p>
  );
}
