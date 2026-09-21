import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Printer } from "lucide-react";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { PrintSheet } from "../components/doors/PrintSheet";
import { DOORS_READ_FAILED, describePowerLoss, doorDisplayName } from "../lib/doorsCopy";
import { clubDate } from "../lib/clubClock";
import { UNNAMED_GATE } from "../lib/gateCopy";
import { withDoorsBoundary } from "../components/doors/DoorsErrorBoundary";
import { doorEndpoints, endpoints, type AdminDoorDevice, type AdminSettings } from "../lib/api";

/**
 * The card that goes in the cupboard beside the board.
 *
 * <p>
 * It is what somebody standing at a door at six in the morning needs, and none of it is on
 * their phone — which is the whole argument for printing anything from a web app.
 * </p>
 *
 * <p>
 * <b>What is never on this sheet, and it is a refusal rather than an omission:</b> the club's
 * device API key, the WiFi password, any member name, any scan. The key is the club's master
 * credential — it registers boards, reads heartbeats and, once a door is named, pulls the
 * whole current roster — and the entire point of this card is that it lives on a wall in a
 * corridor. The temptation to print it so a re-flash is easy is exactly the wrong trade.
 * </p>
 *
 * <p>
 * The printed date and "check it is still right" are there because a card in a cupboard
 * outlives the fact it states, and an undated one is read as current for ever.
 * </p>
 */
function AdminDoorsCardPageBody() {
  const { id = "" } = useParams();
  const [door, setDoor] = useState<AdminDoorDevice | null>(null);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  /** The instant this sheet was built, stamped once. See `printedOn` below. */
  const [builtAt, setBuiltAt] = useState(0);

  const load = useCallback(async () => {
    setBuiltAt(Date.now());
    try {
      const view = await doorEndpoints.doors();
      const row = view.doors.find((d) => d.device.id === id);
      setDoor(row?.device ?? null);
      setFailed(false);
    } catch {
      setFailed(true);
      setDoor(null);
    } finally {
      setLoading(false);
    }
    try { setSettings(await endpoints.adminSettingsGet()); } catch { /* the contact line takes its unset arm */ }
  }, [id]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">Loading this door's card…</p>;
  /**
   * <b>A-M6 / R3-14 — "The doors could not be read" about a door that is not there.</b>
   *
   * <p>
   * The two were one branch, so a card URL for a deleted or mistyped door reported a FAILED
   * READ: an admin following a stale link was told the club's doors could not be read at all,
   * and went looking for an outage. A read that landed and found no such door is a different
   * fact and gets the door page's own sentence, word for word, because an admin who reaches
   * both should not have to reconcile two descriptions of one state.
   * </p>
   */
  if (failed) {
    return (
      <div className="space-y-3">
        <Link to="/admin/doors" className="inline-flex min-h-11 items-center text-sm text-accent-strong">← Doors</Link>
        <Alert tone="danger">{DOORS_READ_FAILED}</Alert>
        <Button variant="outline" onClick={() => void load()}>Try again</Button>
      </div>
    );
  }
  if (!door) {
    return (
      <div className="space-y-3">
        <Link to="/admin/doors" className="inline-flex min-h-11 items-center text-sm text-accent-strong">← Doors</Link>
        <p className="text-sm text-text-secondary">
          That door is not on the club's list. It may have been deleted — a board re-registers itself
          on its next heartbeat, with no name.
        </p>
      </div>
    );
  }

  const contact = [settings?.club_contact_phone?.trim(), settings?.club_contact_email?.trim()]
    .filter((part) => part).join(" · ");
  // A13: the one club-locale formatter. This is printed and lives on a wall for months, so
  // "9/19/26" is the last place a month-first date belongs. Read at LOAD rather than during
  // render — it is the instant the card was built, and a clock read in a render body is both
  // impure and a value that can change between two paints of one sheet.
  const printedOn = clubDate(builtAt);

  return (
    <div className="space-y-4">
      <div data-print-hide className="space-y-3">
        <Link to={`/admin/doors/${door.id}`} className="inline-flex min-h-11 items-center text-sm text-accent-strong">
          {`← ${doorDisplayName(door)}`}
        </Link>
        <p className="text-sm text-text-secondary">
          Print this and put it in the cupboard beside the board. It is what somebody standing at the
          door at six in the morning needs, and none of it is on their phone.
        </p>
        <Button variant="outline" onClick={() => window.print()}>
          <Printer size={16} aria-hidden="true" /> Print
        </Button>
      </div>

      <PrintSheet>
        <p className="text-sm">Crusaders Squash</p>
        {/* B22 / C13: the club's OWN name for the door is the headline, and the slug goes
            beneath it. The heading was the slug — "front-door" in 36 px on a card taped to a
            wall — which is the one word on the sheet a member or a volunteer does not use.
            The slug still has to be here: it is what a scan is recorded against. */}
        {/* A11 / R3-21: ONE fallback, and it matters most here — this sheet goes on a wall
            in a corridor for months, and "Door gate" in 36 px names none of the boards in
            the same state. */}
        <h1 className="mt-4 break-words text-4xl font-bold tracking-tight">{doorDisplayName(door)}</h1>
        <p className="mt-1 break-words text-sm uppercase tracking-wide">
          {door.gate_key ?? UNNAMED_GATE}
        </p>
        <dl className="mt-6 space-y-1 text-sm">
          <CardFact label="Board" value={door.device_code} />
          <CardFact label="MAC" value={door.mac_address ?? "not reported"} />
        </dl>
        <CardBlock title="Where this board is">
          {door.location_note ?? "Nobody has written down where this board is."}
        </CardBlock>
        <CardBlock title="With no power, this door is">
          {`${describePowerLoss(door.power_loss_behaviour).toUpperCase()} — this is a property of the lock, not of the app.`}
        </CardBlock>
        <CardBlock title="If this door is not working">
          Check its power and the club WiFi, then open Doors in the Crusaders app.
        </CardBlock>
        <CardBlock title="Club contact">
          {contact || "No club contact is recorded. Ask at the club."}
        </CardBlock>
        <p className="mt-6 text-xs">
          {`Printed ${printedOn} from Crusaders Mainframe. Check it is still right.`}
        </p>
      </PrintSheet>
    </div>
  );
}

/** A1: see {@link AdminDoorsLogPage}. Every doors route is exported through the boundary. */
export const AdminDoorsCardPage = withDoorsBoundary(AdminDoorsCardPageBody);

function CardFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{value}</dd>
    </div>
  );
}

function CardBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="min-w-0 break-words text-sm">{children}</p>
    </section>
  );
}
