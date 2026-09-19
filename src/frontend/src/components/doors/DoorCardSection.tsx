import { Link } from "react-router-dom";
import { Card } from "../Card";
import { Button } from "../Button";
import { DoorCardEditor, DoorCardRead } from "./DoorCardFields";
import { UNNAMED_GATE } from "../../lib/gateCopy";
import { type AdminDoorDevice, type AdminSettings, type PowerLossBehaviour } from "../../lib/api";

/**
 * The door card, between the feed and the controls — because the person reading it is
 * usually about to walk to the board.
 */
export function DoorCardSection({ door, settings, editing, onEdit, onClose, onSave }: {
  door: AdminDoorDevice;
  settings: AdminSettings | null;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  onSave: (note: string, behaviour: PowerLossBehaviour) => Promise<boolean>;
}) {
  return (
    <section aria-labelledby="door-card-heading" className="space-y-2">
      <h2 id="door-card-heading" className="text-lg font-semibold">Door card</h2>
      <Card className="space-y-4">
        {editing ? (
          <DoorCardEditor door={door} onSave={onSave} onClose={onClose} />
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
              <Button variant="outline" onClick={onEdit}>Edit</Button>
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
