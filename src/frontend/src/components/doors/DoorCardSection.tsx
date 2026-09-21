import { useEffect, useRef } from "react";
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
export function DoorCardSection({ door, displayName, settings, editing, onEdit, onClose, onSave }: {
  door: AdminDoorDevice;
  /** A11 / R3-21: what an admin calls this door — never the raw registration placeholder. */
  displayName: string;
  settings: AdminSettings | null;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  onSave: (fields: {
    name: string; gateKey: string; note: string; behaviour: PowerLossBehaviour;
  }) => Promise<boolean>;
}) {
  /**
   * <b>C4: "Edit this door" and its Cancel/Save both dropped focus to `&lt;body&gt;`.</b>
   *
   * Opening the editor unmounts the button, and closing it unmounts the form — a keyboard or
   * screen-reader user was returned to the top of the document twice per edit, with nothing
   * announced. The button is kept and focus returns to it when the editor closes; the editor
   * takes focus to its first field when it opens.
   */
  // A ref on the WRAPPER rather than on the control: `components/Button.tsx` does not forward
  // one and belongs to another lane this round. The wrapper holds exactly one button, so
  // `querySelector` names it unambiguously.
  const controls = useRef<HTMLDivElement>(null);
  // The previous value is a ref, not state: remembering it must not cause a render.
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing) controls.current?.querySelector("button")?.focus();
    wasEditing.current = editing;
  }, [editing]);

  return (
    <section aria-labelledby="door-card-heading" className="space-y-2">
      <h2 id="door-card-heading" className="text-lg font-semibold">Door card</h2>
      <Card className="space-y-4">
        {editing && <GateDetailsEditor device={door} onSave={onSave} onClose={onClose} />}
        {!editing && (
          <>
            <DoorCardRead door={door} />
            <dl className="space-y-1 text-sm">
              <Fact label="Board" value={door.device_code} />
              <Fact label="MAC" value={door.mac_address ?? "not reported"} />
              <Fact label="Firmware" value={door.running_version ?? "not reported"} />
              <Fact label="Door name" value={door.gate_key ?? UNNAMED_GATE} />
            </dl>
            <ClubContact settings={settings} />
          </>
        )}
        {/*
          C4: the trigger stays MOUNTED while the editor is open — `hidden`, not removed — so
          the focus this section returns to it after Cancel or Save has somewhere to land. A
          button that unmounts under its own focus sends a keyboard user to `<body>`, which
          is what a reviewer measured on every re-rendering control on this surface.
        */}
        <div ref={controls} className={`flex flex-wrap gap-2 ${editing ? "hidden" : ""}`}>
          {/* The door's NAME in the accessible name: three "Manage"-shaped controls on
              one admin's screen all reading "Edit" is reviewer B's repeated-link
              finding one control along. */}
          <Button variant="outline" onClick={onEdit} aria-label={`Edit ${displayName}`}>
            Edit this door
          </Button>
          <Link
            to={`/admin/monitoring/doors/${door.id}/card`}
            className="inline-flex min-h-11 items-center rounded-lg border border-control px-5 text-sm font-medium"
          >
            Print this door card
          </Link>
        </div>
      </Card>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {/* B8 / R3-27: a PIXEL width. `w-24` is 6 rem, which at the 32 px root font an older
          volunteer uses is 192 px — wider than the card's whole content box on a 320 px
          phone, so the label alone pushed the row out. What this width protects is a column
          of labels lining up, which does not need to grow with the text — and it is a
          MINIMUM, because at a 32 px root "Firmware" is itself wider than 96 px and a fixed
          width would clip the word to keep the column. */}
      <dt className="min-w-[96px] shrink-0 text-text-muted">{label}</dt>
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
    // B8 / R3-27: an email address has no break opportunity in it, so at 320 px with a 32 px
    // root font `treasurer@crusaderssquash.co.za` pushed the WHOLE PAGE sideways — a card in
    // a grid column sized to its widest unbreakable token. `break-all` rather than
    // `break-words`: an address is one long token and `overflow-wrap: break-word` only
    // breaks where there is nothing else to do, which at this size there is not.
    return (
      <p className="min-w-0 text-sm">
        <span className="text-text-muted">Club contact</span>{" "}
        <span className="break-all">{parts.join(" · ")}</span>
      </p>
    );
  }
  return (
    <p className="text-sm text-text-secondary">
      No club contact is set. Add one under{" "}
      <Link to="/admin/settings" className="text-accent-strong underline">Admin settings</Link>
      {" "}— it is what a member sees when a door turns them away.
    </p>
  );
}
