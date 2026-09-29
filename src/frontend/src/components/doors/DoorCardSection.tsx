import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Panel as Card } from "../ui/card";
import { Button } from "../ui/button";
import { PencilSimple, Printer } from "../ui/icons";
import { TextLink } from "../ui/text-link";
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
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
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
          <Button variant="outline" className="h-auto min-h-touch whitespace-normal py-2" onClick={onEdit} aria-label={`Edit ${displayName}`} icon={<PencilSimple aria-hidden="true" />}>
            Edit this door
          </Button>
          {/* It navigates, so it is a link — dressed as a button only because it is a CTA. */}
          <Button asChild variant="outline" className="h-auto min-h-touch whitespace-normal py-2">
            <Link to={`/admin/monitoring/doors/${door.id}/card`}>
              <Printer size={16} aria-hidden="true" />
              Print this door card
            </Link>
          </Button>
        </div>
      </Card>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    // `contents`: the row's two cells sit in the list's own two-column grid, so the labels
    // line up by the widest label rather than by a fixed width. B8 / R3-27 measured a `w-24`
    // (6rem) label column at 192px under a 32px root font — wider than the card at 320px; an
    // `auto` column is only ever as wide as the words, at any root size.
    <div className="contents">
      <dt className="text-text-muted">{label}</dt>
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
      <TextLink to="/admin/settings">Admin settings</TextLink>
      {" "}— it is what a member sees when a door turns them away.
    </p>
  );
}
