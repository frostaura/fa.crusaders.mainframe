import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Cpu, DoorClosed, Wifi, WifiOff } from "lucide-react";
import {
  endpoints, isGate, type AdminCourt, type AdminDevice, type AdminSettings, type DeviceActivityEntry,
} from "../lib/api";
import { isOnline, offlineAfterSecondsFor, relative } from "../lib/deviceLiveness";
import { useTicker } from "../lib/useTicker";
import { OFFLINE_WHO_NOTE, doorDisplayName, doorStateChip } from "../lib/doorsCopy";
import { describeDeviceError } from "../lib/deviceErrors";
import {
  ACTIVITY_READ_FAILED, activityEmptyNotice, activityPanelTitle, describeActivityAction,
  describeActivityReason, describeActivityWho, unacknowledgedBoardsNotice,
} from "../lib/deviceActivity";
// R3 adoption: the club's clock, not the reader's. The `lib/utils` formatter this replaced
// renders through `toLocaleString(undefined, …)`, so this feed read "9/19/26, 9:25 PM" on an
// admin laptop set to en-US while every other time on the doors surface read
// "19 September 2026, 21:25". Two formats on one estate is what makes reconciling a night
// after an incident guesswork. `pages/AdminDevices.tsx` is on `clubClock.test.ts`'s SURFACES
// list from the same commit, so the old formatter cannot come back unnoticed.
import { clubInstant } from "../lib/clubClock";
import {
  coverageWithout, outOfServiceConfirm, outOfServiceConsequences, type CourtCoverage,
} from "../lib/deviceCoverage";
import { UNNAMED_GATE, describeGate } from "../lib/gateCopy";
import { Card } from "../components/Card";
import { Badge, Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { ButtonMapEditor, buttonMapWithinCap, MAX_GRANT_MINUTES, RELAYS } from "../components/ButtonMapEditor";
import { ClubButtonMapCard, WalkUpCapNotice } from "../components/ClubButtonMapCard";
import { DeviceApiKeyPanel } from "../components/DeviceApiKeyPanel";
import { MonitoringNav } from "../components/monitoring/MonitoringSection";
import { useToast } from "../components/Toast";

/**
 * Devices — the club's boxes, under the hobby-grade device contract.
 *
 * <p>
 * The screen this replaces was built for a device contract that no longer exists:
 * a discovery listener the box announced itself to, a claim code read off its LCD, a
 * per-device key issued once and never shown again, plus rotate, revoke and re-claim to
 * manage the keys that produced. That is a fleet-management posture for a club that owns
 * four boxes and flashes them on a kitchen table.
 * </p>
 *
 * <p>
 * What replaces it is one static API key for the whole club, flashed into every box's
 * `secrets.h`, and self-registration: a box that presents the key with a device code
 * nobody has seen before gets a row on its first heartbeat. So this screen has exactly
 * three jobs — hand the admin the key, show what has registered itself, and decide what
 * the buttons mean.
 * </p>
 *
 * <p>
 * A court box drives up to four courts, one per relay. The relay letters A–D are the
 * physical outputs; which court sits on each is decided here, in relay order, and the
 * tenant's button map addresses courts by that same letter. The two are checked against
 * each other on every save — from either screen — so a button can never select a relay
 * the box does not have a court on.
 * </p>
 *
 * <p>
 * A DOOR GATE is the second kind of board on this list and shares almost nothing with a
 * box but the key, the heartbeat and the liveness badge. It drives no courts and has no
 * buttons, so it gets neither editor and none of the court-coverage copy; its one piece of
 * configuration is the door's name, because there is one firmware for every door and
 * nothing per-gate is compiled in. A row's kind is not editable from here at all — it is
 * set by the board's first heartbeat, and changing it means deleting the row and letting
 * the board register itself again. What a gate SAYS when it is taken out of service is in
 * {@link gateCopy}, deliberately apart from the box's, because every sentence the box side
 * says is about courts going dark and no-show penalties being waived and none of it is
 * true of a door.
 * </p>
 */

/**
 * How often the page re-reads the boards, milliseconds.
 *
 * <p>
 * This screen's entire content is liveness — "online" / "last seen Nm ago" — and the
 * peripheral-health email tells an admin to open it and watch a box recover. It loaded once
 * on mount and never again, so the page the alert LINKS TO showed the state at the moment
 * it was opened: a tab left open read "online" for a box six and a half minutes dark, more
 * than double the offline threshold and long after the club had been emailed about it
 * (finding M-F2).
 * </p>
 *
 * <p>
 * Fifteen seconds is the firmware's own minimum heartbeat interval, so the page cannot be
 * more than one beat behind the fastest box a club can configure. Only the device list is
 * re-read; the settings and courts behind it change when an admin changes them.
 * </p>
 */
const REFRESH_MS = 15_000;

/** "A: court 1, B: court 2" — the relay bank as an admin reads it off the box. */
function describeCourts(courtNumbers: number[]) {
  if (courtNumbers.length === 0) return "no courts";
  return courtNumbers.map((n, i) => `${RELAYS[i]}: court ${n}`).join(", ");
}

/**
 * The one line under a board's name: its code, what it is, and whatever it reported about
 * itself. Built as a list rather than a run of inline ternaries in the JSX, because the
 * second kind of board turned five conditionals into eight and pushed the header past the
 * complexity gate — and because the separator is then written once instead of six times.
 *
 * The second element is the whole difference between the two kinds: a box says which court
 * sits on which relay, a door says which door it is.
 */
function identityLine(device: AdminDevice): string {
  const parts = [
    device.device_code,
    isGate(device) ? describeGate(device.gate_key) : describeCourts(device.court_numbers),
  ];
  if (device.mac_address) parts.push(device.mac_address);
  if (device.last_ip_address) parts.push(device.last_ip_address);
  if (device.running_version) parts.push(`firmware ${device.running_version}`);
  if (device.mega_version) parts.push(`Mega ${device.mega_version}`);
  return parts.join(" · ");
}

// --- relay → court editor -------------------------------------------------------

/**
 * Assigns a court to each relay, A first.
 *
 * The list is contiguous by construction: relay B cannot be set until A is, and
 * clearing A clears everything after it. A gap would be a relay index the API cannot
 * represent — `court_numbers` is positional — so the editor makes one impossible rather
 * than validating it away.
 */
function CourtListEditor({
  value, onChange, courts, disabled, labelPrefix,
}: {
  value: number[];
  onChange: (next: number[]) => void;
  courts: AdminCourt[];
  disabled?: boolean;
  /** Distinguishes editors that share a screen: "" → "Relay A court", "Court 1 box" → "Court 1 box relay A court". */
  labelPrefix?: string;
}) {
  if (courts.length === 0) {
    return (
      <p className="text-sm text-amber-800">
        No courts to assign yet. Add the club's courts under Admin settings first.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {RELAYS.map((relay, index) => {
        const current = value[index];
        const reachable = !disabled && index <= value.length;
        const label = `${labelPrefix ? `${labelPrefix} relay` : "Relay"} ${relay} court`;
        return (
          <div key={relay} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-sm text-slate-500">Relay {relay}</span>
            <select
              aria-label={label}
              className="min-h-11 rounded-lg border border-slate-200 bg-white px-2 text-sm disabled:opacity-50"
              value={current ?? ""}
              disabled={!reachable}
              onChange={(e) => {
                if (e.target.value === "") onChange(value.slice(0, index));
                else onChange([...value.slice(0, index), Number(e.target.value), ...value.slice(index + 1)]);
              }}
            >
              <option value="">{index === 0 ? "Choose a court" : "— none —"}</option>
              {courts.map((court) => (
                <option
                  key={court.id}
                  value={court.court_number}
                  disabled={value.includes(court.court_number) && current !== court.court_number}
                >
                  Court {court.court_number} — {court.name}{court.is_active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}

// --- one board's own button map ------------------------------------------------

/**
 * A box's own button map, or the club's.
 *
 * Rendered only when the device payload carries `button_map` — an older API that does
 * not send it must not show an editor whose save would bind to nothing. Null means
 * "the club's map".
 */
function DeviceButtonMapPanel({
  device, clubMap, walkUpMax, onSave, onClose,
}: {
  device: AdminDevice;
  clubMap: string[];
  /** The club's walk-up maximum, for the notice. Null when settings have not loaded. */
  walkUpMax: number | null;
  onSave: (map: string[] | null) => Promise<boolean>;
  onClose: () => void;
}) {
  const [own, setOwn] = useState(device.button_map != null);
  const [draft, setDraft] = useState<string[]>(device.button_map ?? clubMap);
  const [saving, setSaving] = useState(false);
  const group = `${device.id}-map-source`;

  async function save() {
    setSaving(true);
    try {
      if (await onSave(own ? draft : null)) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3">
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name={group} checked={!own} onChange={() => setOwn(false)} disabled={saving} />
          Use the club's button map
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={group} checked={own} onChange={() => setOwn(true)} disabled={saving} />
          Own map for this box
        </label>
      </div>
      {own && <ButtonMapEditor value={draft} onChange={setDraft} disabled={saving} labelPrefix={device.name} />}
      <WalkUpCapNotice map={own ? draft : clubMap} cap={walkUpMax} />
      <div className="flex gap-2">
        <Button className="min-h-11 px-3 text-sm" onClick={() => void save()} disabled={saving || (own && !buttonMapWithinCap(draft))}>
          {saving ? "Saving…" : "Save buttons"}
        </Button>
        <Button variant="ghost" className="min-h-11 px-3 text-sm" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

// --- one board in the list --------------------------------------------------

/** Everything a row can ask the page to do to its device. */
type DeviceActions = {
  details: (name: string, courtNumbers: number[]) => Promise<boolean>;
  buttonMap: (map: string[] | null) => Promise<boolean>;
  /** Out of service, or back in. See DeviceRow for what the switch actually does. */
  setEnabled: (enabled: boolean) => Promise<void>;
  remove: () => Promise<void>;
};

/**
 * Name and courts, saved together.
 *
 * <p>
 * They are one edit because they arrive as one job: a self-registered box shows up as
 * `box-a1b2c3` driving whatever the API defaulted it to, and both are wrong at the same
 * moment. Splitting them into two panels would mean two saves and two chances to clear
 * the "new" badge with half the work done.
 * </p>
 */
function DeviceDetailsEditor({
  device, courts, onSave, onClose,
}: {
  device: AdminDevice;
  courts: AdminCourt[];
  onSave: (name: string, courtNumbers: number[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(device.name);
  const [draft, setDraft] = useState<number[]>(device.court_numbers);
  const [saving, setSaving] = useState(false);
  const nameId = `${device.id}-name`;

  async function save() {
    setSaving(true);
    try {
      if (await onSave(name.trim() || device.name, draft)) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3">
      <div>
        <Label htmlFor={nameId}>Name</Label>
        <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="Court 1 box" disabled={saving} />
      </div>
      <div>
        <Label>Courts, by relay</Label>
        <p className="mb-2 text-xs text-slate-500">
          Relay A is the first output on the box. Assign the courts in the order they are wired.
        </p>
        <CourtListEditor value={draft} onChange={setDraft} courts={courts} disabled={saving} labelPrefix={device.name} />
      </div>
      <div className="flex gap-2">
        <Button className="min-h-11 px-3 text-sm" onClick={() => void save()} disabled={saving || draft.length === 0}>
          {saving ? "Saving…" : "Save box"}
        </Button>
        <Button variant="ghost" className="min-h-11 px-3 text-sm" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

/** The badges and the identity line — everything about a row that is read-only. */
function DeviceRowHeader({ device, online, now }: { device: AdminDevice; online: boolean; now: number }) {
  // Presence-gated: an API that does not send the field cannot have an override.
  const hasOwnMapField = device.button_map !== undefined;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {device.enabled && online
          ? <Wifi className="h-4 w-4 text-emerald-500" aria-label="online" />
          : <WifiOff className="h-4 w-4 text-slate-300" aria-label={device.enabled ? "offline" : "out of service"} />}
        {/* min-w-0 so a long name gives way inside the flex row instead of setting its
            width; break-words so it wraps rather than running off the card. */}
        <span className="min-w-0 break-words font-medium">{device.name}</span>
        {/* A box an admin switched off is not "offline" — nobody expects it to call in,
            and showing it beside the boxes that have genuinely gone quiet is how a club
            learns to ignore the state that matters. Silence is loud, though: a box that
            has gone quiet on its own gets the danger tone, not the neutral grey it had
            while a louder amber "New" badge sat next to it (M-F2, secondary). */}
        {!device.enabled
          ? <Badge tone="muted">out of service</Badge>
          : (
            <Badge tone={online ? "success" : "danger"}>
              {online ? "online" : `not reporting — last seen ${relative(device.last_seen_at, now)}`}
            </Badge>
          )}
        {/* A box registers itself with a generated name and default courts. Until an
            admin has looked, the club has a live box whose relays probably point at the
            wrong courts — which is a league night with the wrong lights on, not a
            cosmetic gap. The badge clears when the row is edited.

            A DOOR's equivalent badge is not here any more (A2.5): a doors-first page keys
            the job on the missing NAME rather than on the new-board flag, because a door
            that was named months ago and never edited is fine and one whose name somebody
            cleared is not. See doorSetupChip in lib/doorsCopy. */}
        {device.auto_registered && <Badge tone="warning">New — check court numbers</Badge>}
        {hasOwnMapField && device.button_map != null && <Badge tone="info">own button map</Badge>}
      </div>

      {/* break-words, because a gate key may be 64 characters of somebody's own naming
          scheme with no space in it, and this line already carries a device code, a MAC and
          two version strings. The row used to push the page wider than the phone on a long
          device NAME alone (R2 I-F6); an unbreakable 64-character token is the same defect
          with a larger token. */}
      <div className="mt-1 break-words text-xs text-slate-500">{identityLine(device)}</div>
    </>
  );
}

/**
 * What "out of service" actually means, said on the rows where it is in force rather than
 * buried in a tooltip.
 *
 * <p>
 * Every sentence on the BOX branch is something the code does: DeviceIdentity answers 403 for
 * `!device.IsActive`, and the routes it guards are the four under `/api/v1/device/`
 * (heartbeat, events, walkup, activate); PeripheralHealthWorker filters `d.Enabled`;
 * DeviceOutageIndex builds its silence index from the enabled boxes alone — and a court whose
 * enabled boxes are all silent, or all switched off, is dark, so the no-shows on it are
 * refunded in full with no penalty, from the instant `devices.OutOfServiceSince` records.
 * </p>
 *
 * <p>
 * That last clause is the one this notice has now got wrong three times. It said flatly that
 * the box's courts "are judged by whatever other boxes drive them", which names nothing in
 * exactly the state that costs money; the round that fixed that then said the opposite in the
 * state where the covering box is in service but has gone quiet, which the settlement calls
 * dark; and the round that fixed THAT promised the waiver from the click while the ledger
 * still waited out `offline_after_seconds`. See outOfServiceConsequences in lib/deviceCoverage,
 * which both this and the toast read, so the two cannot disagree again — and which is where
 * every word that varies with number is now decided, over one test matrix, because three
 * rounds running shipped a sentence that disagreed with the one beside it.
 * </p>
 *
 * <p>
 * Note what this comment used to say and no longer does: "refuses a disabled box 403 on every
 * endpoint". DeviceIdentity is not on the courtside match routes at all — see the shut bullet
 * on coverageWithout — and reading it that way is where the page's own "nobody can check in
 * there" came from.
 * </p>
 *
 * <p>
 * <b>A GATE never reaches this notice at all (A2.5).</b> A door drives no courts, so every
 * clause above about a court going dark and its no-shows being waived is simply not true of
 * one — and rather than a second branch here, a door is shut on /admin/monitoring/doors, where
 * `doorStateNotice` says the door's own consequence. Two call sites for one 403 path is the
 * failure `lib/gateCopy.ts`'s header documents.
 * </p>
 */
function OutOfServiceNotice({ device, coverage }: { device: AdminDevice; coverage: CourtCoverage }) {
  return (
    <p className="mt-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
      {`Out of service. The API refuses this box, so it switches nothing on, and the club is not`
        + ` alerted about its silence. ${outOfServiceConsequences(coverage).join(" ")}`}
      <span className="sr-only">{device.name}</span>
    </p>
  );
}

// --- a board's own trail ---------------------------------------------------------

/**
 * One row of the trail: what happened, to whom, why, and when.
 *
 * <p>
 * Its own component rather than a `map` body inside the panel, because the panel is
 * already a loader with four states and the complexity gate holds this file at its bound.
 * </p>
 *
 * <p>
 * Two lines, not four columns. Fifty rows of four columns on a phone is four columns of
 * two characters each; the decision goes on the first line with its age, and who and why
 * share the second. A row with neither — a boot — renders one line rather than an empty
 * second one.
 * </p>
 *
 * <p>
 * `title` on the action carries the raw token. The words are for reading; the token is for
 * whoever has to report a new action upstream, and losing it would make a humanised
 * unknown unsearchable.
 * </p>
 */
function ActivityRow({ entry, now }: { entry: DeviceActivityEntry; now: number }) {
  const who = describeActivityWho(entry);
  const why = describeActivityReason(entry);
  const detail = [who, why].filter((part) => part !== null).join(" · ");
  return (
    <li className="border-t border-slate-100 py-1.5 first:border-t-0">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 break-words font-medium text-slate-700" title={entry.action}>
          {describeActivityAction(entry)}
        </span>
        {/* Relative for the glance, exact on hover or long-press for the reconciliation —
            the pair the liveness line above and the ledger both already use. */}
        <time dateTime={entry.at} title={clubInstant(entry.at)} className="ml-auto shrink-0 text-slate-400">
          {relative(entry.at, now)}
        </time>
      </div>
      {/* min-w-0 AND break-words: a member's display name is the one arbitrarily wide
          thing in this panel, and a row that sets its own width pushes the whole page
          wider than the phone (R2 I-F6) — fifty times over, here. */}
      {detail && <div className="mt-0.5 min-w-0 break-words text-slate-500">{detail}</div>}
    </li>
  );
}

/** What the panel is showing right now, once the four states are collapsed into one read. */
function ActivityBody({ entries, loading, error, gate, now }: {
  entries: DeviceActivityEntry[] | null;
  loading: boolean;
  error: string | null;
  gate: boolean;
  now: number;
}) {
  if (loading) return <p className="text-xs text-slate-500">Loading…</p>;
  // Before empty, deliberately. A failed read that rendered "nothing recorded yet" would
  // be making a claim about the DOOR ("nobody has been through it") out of a claim about
  // the request, which is how an admin concludes a working door is dead.
  if (error) return <p className="text-xs text-danger-strong">{error}</p>;
  if (!entries || entries.length === 0) return <p className="text-xs text-slate-500">{activityEmptyNotice(gate)}</p>;
  return (
    <>
      {/* A3, on the panel it was missed on. A reviewer read nine offline rows — some naming
          a member, some not — with nothing reconciling the two, and concluded records had
          been lost. They had not: an offline board decides from the list it last
          downloaded, so a code ON that list resolves to its holder and one that is not
          resolves to nobody. Said once, where the offline rows are, rather than left to be
          inferred; the doors surface has carried this since the finding landed and this
          panel serves the same rows for a court box. */}
      {entries.some((entry) => entry.offline) && (
        <p className="mb-1 text-xs text-slate-500">{OFFLINE_WHO_NOTE}</p>
      )}
      <ul className="text-xs">
        {entries.map((entry, i) => <ActivityRow key={`${entry.at}-${entry.action}-${i}`} entry={entry} now={now} />)}
      </ul>
    </>
  );
}

/**
 * A board's own trail, collapsed until an admin asks for it.
 *
 * <p>
 * <b>Why this screen at all.</b> The door has written an audit row for every scan since it
 * shipped and nothing read one, so "why was I turned away at the front door last night"
 * had a database query as its only answer — and the seven refusal reasons had travelled
 * through the firmware, the wire corpus and the spec for three rounds without ever becoming
 * a sentence anybody could read.
 * </p>
 *
 * <p>
 * <b>Shut by default and fetched on open.</b> A club with eight boards would otherwise make
 * eight extra calls on every load of a page that already re-reads itself every fifteen
 * seconds, for panels nobody opened. Re-fetched on every open rather than cached, because
 * the trail is the one thing on this row that a member standing at the door changes while
 * the admin is looking at it.
 * </p>
 *
 * <p>
 * No `mounted` ref and no cleanup guard: this is event-driven, not effect-driven, so
 * StrictMode's mount → cleanup → mount cannot leave a ref false before the first click —
 * the shape that has produced two defects in this repo.
 * </p>
 *
 * <p>
 * The label does not change with the state; `aria-expanded` carries it. A control whose
 * accessible name flips between "Door activity" and "Hide door activity" is a control a
 * screen-reader user has to re-find after every press.
 * </p>
 */
function DeviceActivityPanel({ device, now }: { device: AdminDevice; now: number }) {
  const gate = isGate(device);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DeviceActivityEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      setEntries((await endpoints.adminDeviceActivity(device.id)).items);
    } catch (e) {
      setError(describeDeviceError(e, ACTIVITY_READ_FAILED));
      setEntries(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2">
      <Button
        variant="outline"
        className="min-h-11 px-3 text-sm"
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        {activityPanelTitle(gate)}
      </Button>
      {open && (
        <div className="mt-2 rounded-lg bg-slate-50 p-3">
          <ActivityBody entries={entries} loading={loading} error={error} gate={gate} now={now} />
        </div>
      )}
    </div>
  );
}

/**
 * What the court-box editors on a row need from the page, travelling as one thing.
 *
 * <p>
 * The three are grouped because they are one concern and because a gate uses none of them:
 * a door has no relay bank to assign courts to and no buttons to map. Spread flat they
 * were three of seven props on {@link DeviceRow}, which is over the complexity gate's
 * parameter bound once a second kind of board is on the list — and the grouping says why
 * they belong together, which seven flat props did not.
 * </p>
 */
type BoxEditing = {
  courts: AdminCourt[];
  clubMap: string[];
  /** The club's walk-up maximum, for the button-map notice. */
  walkUpMax: number | null;
};

/**
 * When this board counts as deaf, and the instant that is judged against.
 *
 * One prop rather than two because they are one question, and because seven flat props put
 * `DeviceRow` over the complexity gate's parameter bound the moment a ticking clock arrived.
 */
type Liveness = { offlineAfter: number; now: number };

/**
 * The id of the control that REPLACES "Take out of service" once it has run. (R3 adoption)
 *
 * <p>
 * `ConfirmButton.focusAfter` is called repeatedly for about a second after the action
 * settles, precisely so it can name a control the re-render has not produced yet — so a
 * stable id is all it needs, and a ref would have to be threaded through two components
 * that do not otherwise know about each other. Derived from the device id rather than the
 * name, because two boxes called "Court box" is a club's own business.
 * </p>
 */
function backInServiceId(deviceId: string): string {
  return `device-${deviceId}-back-in-service`;
}

function DeviceRow({
  device, boxEditing, actions, liveness, coverage,
}: {
  device: AdminDevice;
  boxEditing: BoxEditing;
  actions: DeviceActions;
  liveness: Liveness;
  /** What each of this box's courts would be left with without it. See lib/deviceCoverage. */
  coverage: CourtCoverage;
}) {
  const { now } = liveness;
  const online = isOnline(device, liveness.offlineAfter, now);
  const [editing, setEditing] = useState<"details" | "buttons" | null>(null);
  // Presence-gated: an API that does not send the field gets no editor for it.
  const hasOwnMapField = device.button_map !== undefined;

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <DeviceRowHeader device={device} online={online} now={now} />

      {editing === "details" && (
        <DeviceDetailsEditor device={device} courts={boxEditing.courts} onSave={actions.details} onClose={() => setEditing(null)} />
      )}

      {editing === "buttons" && (
        <DeviceButtonMapPanel
          device={device}
          clubMap={boxEditing.clubMap}
          walkUpMax={boxEditing.walkUpMax}
          onSave={actions.buttonMap}
          onClose={() => setEditing(null)}
        />
      )}

      {!device.enabled && <OutOfServiceNotice device={device} coverage={coverage} />}

      {/* Above the action strip, because it is the one control on this row that reads
          rather than writes — and an admin usually opens it to decide whether to press
          one of the others. */}
      <DeviceActivityPanel device={device} now={now} />

      {/*
        <b>B11 / R3-27 — every control on this strip measured 32–36 px.</b>
        The doors surface is built to 44 px because it is used standing up in a club, and
        this page is used in exactly the same circumstances by exactly the same volunteer.
        The two sat one gear-menu item apart with a 12 px difference in target size.
        `min-h-11` rather than `h-11`, so a control whose words wrap grows instead of
        clipping them — which is what `h-*` did at a 32 px root font.
      */}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        {editing === null && (
          <Button variant="outline" className="min-h-11 px-3 text-sm" onClick={() => setEditing("details")}>
            Edit name and courts
          </Button>
        )}

        {hasOwnMapField && editing === null && (
          <Button variant="outline" className="min-h-11 px-3 text-sm" onClick={() => setEditing("buttons")}>
            Edit buttons
          </Button>
        )}

        {/* Out of service — the control the API, the health sweep and the settlement model
            were all written around and that no screen offered (finding M-F3). Without it a
            box that is broken or has been unplugged for good stays enabled for ever, so the
            club is alerted about a silence it created, and — because a court is "dark" only
            when every ENABLED box driving it is dark — every no-show on that box's courts is
            refunded with no penalty, indefinitely. The only lever the page had was Delete,
            which the page itself describes as a reset: the box re-registers on its next
            heartbeat, so it is useless for a box that is still powered.

            Confirmed on the way out, because a live box stops working; plain on the way
            back, because restoring a box is not a decision anyone regrets.

            A DOOR is not offered this control at all any more (A2.5): its own vocabulary is
            "Shut" and "Reopen", the consequence is the opposite one, and two call sites for
            one 403 path is the failure lib/gateCopy's header documents. Doors are shut on
            /admin/monitoring/doors. */}
        {device.enabled ? (
          <ConfirmButton
            idleLabel="Take out of service"
            cancelLabel="Leave it in service"
            // The confirm names the consequence that is hardest to undo knowing about, per
            // court and only where it is true — see outOfServiceConfirm in lib/deviceCoverage.
            // An admin taking a spare out of service beside a box that is reporting gets the
            // plain sentence.
            confirmLabel={outOfServiceConfirm(coverage)}
            // R3 adoption. `subject` names what is being KEPT, so the way out reads
            // "Leave it in service — Court box 1-4" rather than carrying the destructive
            // verb in its own accessible name; `focusAfter` lands on the control that
            // replaces this one, which is the only thing on the row that can tell the
            // reader the action landed. Both are additive props the R3 chrome lane added
            // to ConfirmButton and that no call site on this page had taken up.
            subject={device.name}
            focusAfter={() => document.getElementById(backInServiceId(device.id))}
            onConfirm={() => actions.setEnabled(false)}
          />
        ) : (
          <Button
            id={backInServiceId(device.id)}
            variant="outline"
            className="min-h-11 px-3 text-sm"
            onClick={() => void actions.setEnabled(true)}
          >
            Put back in service
          </Button>
        )}

        {/* Deleting is not a revocation and locks nothing out — the box still holds the
            club's key. It forgets the row, and the box makes a new one on its next call.
            The confirm label says exactly that, because "Really delete?" would let an
            admin think they had just taken a box off the network. */}
        <ConfirmButton
          idleLabel="Delete"
          cancelLabel="Keep this box"
          confirmLabel="Delete? The box re-registers on its next heartbeat."
          // R3 adoption, and deliberately only the one prop. `subject` makes the way out
          // read "Keep this box — Court box 1-4" in a column of identical controls. There
          // is no `focusAfter`: the row this button lives in is gone the moment the action
          // settles, so the only honest destination is the page's own heading, which is
          // exactly what ConfirmButton does when the prop is absent. Naming a successor
          // that will never exist would hold focus on `<body>` for the full second the
          // retry loop runs.
          subject={device.name}
          onConfirm={actions.remove}
          tone="danger"
        />
      </div>
    </div>
  );
}

/**
 * The club's doors, read-only, under their own heading (A2.5 / D5).
 *
 * <p>
 * <b>Visible here, edited only on Doors.</b> W1.1 says court boxes stay on this page and
 * gates appear on both, which is right about VISIBILITY and wrong about control: if
 * `GateDetailsEditor`, the gate branch of the out-of-service notice and the gate delete
 * confirm have two call sites, this repo has already documented what happens next —
 * `lib/gateCopy.ts` exists because the court-box consequence "was written three times at
 * three call sites and shipped three rounds running with the three of them disagreeing about
 * what the click had just done". Two screens is two call sites.
 * </p>
 *
 * <p>
 * So a door is one line here: its liveness, its door name, a ticking age and a link. Nothing
 * on this page edits, names, shuts, reopens or deletes a door.
 * </p>
 */
function GateRows({ gates, tenantHeartbeat, now }: {
  gates: AdminDevice[];
  tenantHeartbeat: number | null;
  now: number;
}) {
  if (gates.length === 0) return null;
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <div className="mb-2 flex items-center gap-2">
        <DoorClosed className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Doors</h3>
      </div>
      <ul className="space-y-2">
        {gates.map((gate) => {
          const online = isOnline(gate, offlineAfterSecondsFor(gate, tenantHeartbeat), now);
          const chip = doorStateChip(gate, online);
          // A11: "Door gate" is the placeholder every self-registering gate arrives with,
          // and the doors surface stopped presenting it as a name — five boards in that
          // state all read "Door gate" and named none of them. This row links straight to
          // that surface, so it cannot call the same board something else.
          const name = doorDisplayName(gate);
          return (
            <li key={gate.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-3">
              {/* A8: `doorStateChip` answers null where the caller cannot say whether a
                  door is reporting. This page always can — it resolves `online` from a read
                  it has just made — so the chip is always here; the guard is the type
                  saying so rather than a claim this call site is allowed to make. */}
              {chip && <Badge tone={chip.tone}>{chip.label}</Badge>}
              <span className="min-w-0 break-words text-sm font-medium">{name}</span>
              <span className="min-w-0 break-words text-xs text-slate-500">
                {`${gate.gate_key ?? UNNAMED_GATE} · ${gate.device_code}`}
              </span>
              <time
                dateTime={gate.last_seen_at ?? undefined}
                aria-live="off"
                className="text-xs text-slate-500"
              >
                {relative(gate.last_seen_at, now)}
              </time>
              <Link
                to={`/admin/monitoring/doors/${gate.id}`}
                className="ml-auto inline-flex min-h-11 items-center rounded-lg border border-control px-4 text-sm font-medium"
                /* The door's NAME in the accessible name. Reviewer B met three links reading
                   "Manage on Doors" on one screen — identical to anybody tabbing or using
                   speech control, and distinguished only by which row they happen to sit in,
                   which is visual position and therefore nothing at all. */
                aria-label={`Manage ${name} on Doors`}
              >
                Manage on Doors
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-slate-500">Doors are set up and shut under Doors.</p>
    </div>
  );
}

// --- the page ---------------------------------------------------------------

/**
 * What the toast says after the out-of-service switch is thrown, either way.
 *
 * <p>
 * The out-of-service half is the SAME generator the row notice above renders — for a box
 * {@link outOfServiceConsequences}, for a gate {@link doorShutNotice} — because
 * the toast is the half an admin actually reads (the row is behind it) and round 8 shipped
 * the two of them saying different things about one click. A module-level function rather
 * than a ternary inside the action object, so the gate branch is not a fourth nested
 * conditional in a hook that already has several.
 * </p>
 *
 * <p>
 * Every clause on the box branch is a consequence the code has: the health sweep filters on
 * Enabled, the silence index the no-show waiver reads does too, and a court left with no box
 * in service is dark from the instant this PATCH lands, because DeviceRegistryService
 * stamps `OutOfServiceSince` on the transition and DoorWasShutFor answers from it. That last
 * one is what this toast used to say the opposite of, by promising the box's courts were
 * "judged by whatever other boxes drive them" in the very state where there are none — and
 * what it then promised too EARLY, for the `offline_after_seconds` the ledger used to wait
 * out before honouring the same sentence.
 * </p>
 */
function enabledToast(device: AdminDevice, coverage: CourtCoverage, enabled: boolean): string {
  return enabled
    ? `${device.name} is back in service. It works again on its next call, and the club is alerted if it goes quiet.`
    : [`${device.name} is out of service. It switches nothing on, and the club is not alerted about its silence.`,
       ...outOfServiceConsequences(coverage)].join(" ");
}

/**
 * What the toast says after a delete.
 *
 * Deleting forgets a row; it revokes nothing, because the board still holds the club's one
 * key. A gate's differs in what comes back — a door with no name, since a gate self-registers
 * with a null key — which is the part an admin has to redo.
 */
function deletedToast(device: AdminDevice): string {
  return `${device.name} deleted. It still has the club's key, so it re-registers on its next heartbeat as a new box — unplug it if you meant to retire it.`;
}

/**
 * The warning that the club is running out of room for new boards.
 *
 * <p>
 * <b>It is here because the refusal is not reachable from this console at all.</b>
 * Auto-registration refuses a new MAC once the tenant holds sixteen rows nobody has
 * acknowledged, and it refuses the BOARD — a 409 `too_many_unacknowledged_devices`
 * answered on the board's own heartbeat, to a piece of firmware with one LED. An admin who
 * flashes a new board and watches it never appear on this list has no error to read
 * anywhere: the screen simply does not grow a row. A warning BEFORE the club gets there is
 * the only form this can take on a screen.
 * </p>
 *
 * <p>
 * Counted on `auto_registered` rather than on how many boards there are. A club with
 * twenty boards an admin has already named is in no danger, and warning it would teach the
 * club to ignore the notice in the state that matters.
 * </p>
 */
function UnacknowledgedBoardsNotice({ devices }: { devices: AdminDevice[] }) {
  const notice = unacknowledgedBoardsNotice(devices.filter((d) => d.auto_registered).length);
  if (notice === null) return null;
  return <p role="status" className="mb-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">{notice}</p>;
}

/**
 * The mutations a row can ask for, built per device. Kept out of the page component
 * so the page stays a loader and a layout.
 */
function useDeviceActions(reload: () => Promise<void>) {
  const toast = useToast();

  return (device: AdminDevice, coverage: CourtCoverage): DeviceActions => ({
    /** Returns whether the save went through, so the row knows whether to leave edit mode. */
    details: async (name, courtNumbers) => {
      try {
        await endpoints.adminDeviceUpdate(device.id, { name, court_numbers: courtNumbers });
        toast.push({ tone: "success", text: `${name} now drives ${describeCourts(courtNumbers)}.` });
        await reload();
        return true;
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not save that box."), durationMs: 8000 });
        return false;
      }
    },
    buttonMap: async (map) => {
      try {
        await endpoints.adminDeviceUpdate(device.id, { button_map: map });
        toast.push({
          tone: "success",
          text: map === null
            ? `${device.name} uses the club's button map again. It picks that up on its next heartbeat.`
            : `${device.name} has its own button map. It picks that up on its next heartbeat.`,
        });
        await reload();
        return true;
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not save that box's buttons."), durationMs: 8000 });
        return false;
      }
    },
    /**
     * Out of service, or back in. `enabled` has been on the API and on the typed client
     * since the row existed and nothing ever sent it — the three mutations above send
     * `{name, court_numbers}`, `{name, gate_key}` and `{button_map}` and nothing else.
     * What the success toast says is {@link enabledToast}'s, which is the same generator
     * the row notice reads.
     */
    setEnabled: async (enabled) => {
      try {
        await endpoints.adminDeviceUpdate(device.id, { enabled });
        toast.push({ tone: "success", text: enabledToast(device, coverage, enabled), durationMs: 8000 });
        await reload();
      } catch (e) {
        toast.push({
          tone: "danger",
          text: describeDeviceError(e, enabled ? "Could not put that board back in service." : "Could not take that board out of service."),
          durationMs: 8000,
        });
      }
    },
    remove: async () => {
      try {
        await endpoints.adminDeviceDelete(device.id);
        toast.push({ tone: "success", text: deletedToast(device), durationMs: 8000 });
        await reload();
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not delete that board.") });
      }
    },
  });
}

export function AdminDevicesPage() {
  const toast = useToast();
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [courts, setCourts] = useState<AdminCourt[]>([]);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [buttonMap, setButtonMap] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * One instant per paint, from one timer (A2.7's extraction).
   *
   * Every age on this page used to read `Date.now()` for itself, so three rows rendered
   * across a second boundary could print two different numbers for one moment — and the page
   * only re-rendered on a poll, so the ages stepped in fifteen-second jumps.
   */
  const now = useTicker(true);

  /**
   * Re-reads the boxes and nothing else — this is the only thing on the page that goes
   * stale on its own. Settings and courts change when an admin changes them, and
   * re-fetching them on a timer would fight the club button map an admin is editing
   * below.
   */
  const refreshDevices = useCallback(async () => {
    setDevices(await endpoints.adminDevicesList());
    setCheckedAt(new Date().toISOString());
  }, []);

  const load = useCallback(async () => {
    const [list, config, courtList] = await Promise.all([
      endpoints.adminDevicesList(),
      endpoints.adminSettingsGet(),
      endpoints.adminCourtsList(),
    ]);
    setDevices(list);
    setSettings(config);
    setButtonMap(config.button_map);
    setCourts(courtList);
    setCheckedAt(new Date().toISOString());
    setLoading(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- as above
  useEffect(() => { void load(); }, [load]);

  /**
   * Keeps the liveness live (finding M-F2).
   *
   * <p>
   * No `mounted` ref and no early-return guard: StrictMode runs mount → cleanup → mount,
   * and a ref written only on cleanup is already false before the first tick — that exact
   * shape has produced two defects in this repo (a confirm button stuck on "Working…" and
   * a dead retry button on the outage screen). Clearing the interval is the whole cleanup,
   * and a second mount simply starts a second interval and clears the first.
   * </p>
   *
   * <p>
   * A failed poll is swallowed: the page keeps whatever it last read and the "checked"
   * line stops advancing, which is the honest thing for it to say. A toast every fifteen
   * seconds while a laptop is off the wifi would be worse than the staleness.
   * </p>
   */
  useEffect(() => {
    // Only while somebody is looking. A club that leaves this tab open all day was making
    // four calls a minute for ever, on a screen whose entire content is "what is happening
    // right now" — nobody is reading it from a background tab, and the data it holds is
    // worthless by the time they come back to it either way.
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void refreshDevices().catch(() => {});
    };

    // And a read on the way back IN, rather than up to fifteen seconds of the state the tab
    // was left in. That is the same failure M-F2 was about — a page the outage email links
    // to, showing a box as online long after the club was emailed that it was not — so a
    // gate that saved requests by widening that window would be trading the fix away.
    const onVisibility = () => { if (document.visibilityState === "visible") tick(); };

    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshDevices]);

  async function refreshNow() {
    setRefreshing(true);
    try {
      await refreshDevices();
    } catch (e) {
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not re-read the boards.") });
    } finally {
      setRefreshing(false);
    }
  }

  const actionsFor = useDeviceActions(load);

  // The bound a minute button is actually held to: the club's own walk-up maximum, never
  // above the relay's hard cap. The editor already refuses anything past the hard cap; the
  // club's cap is the half nothing on this page knew about.
  const walkUpCap = settings ? Math.min(settings.walk_up_max_minutes, MAX_GRANT_MINUTES) : null;

  /** The club's declared heartbeat, for boxes that do not carry their own. */
  const tenantHeartbeat = settings?.heartbeat_seconds ?? null;

  // Boxes get the editors; doors get a read-only row and a link (A2.5).
  const boxes = devices.filter((d) => !isGate(d));
  const gates = devices.filter((d) => isGate(d));

  return (
    // B7 / R3-27: the padding is in PIXELS, for B12's reason. `p-4` is a rem, so at the
    // 32 px root font an older volunteer uses it becomes 32 px a side — 64 px of this page's
    // own padding on a 320 px phone, on top of the shell's. What the padding protects is a
    // GAP, and a gap does not need to grow with the text; what the space it eats protects is
    // a WORD, which does.
    <div className="mx-auto min-w-0 max-w-4xl space-y-6 p-[16px]">
      <h1 className="text-2xl font-bold">Devices</h1>
      {/* eco: Devices was in a gear menu and is a destination now — the section this page was
          moved into is invisible from inside it without this strip, which is the IA problem
          the section was created to fix, re-created one page in. */}
      <MonitoringNav />

      <DeviceApiKeyPanel />

      <Card className="p-5">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <Cpu className="h-5 w-5 text-slate-400" />
          <h2 className="text-lg font-semibold">Connected boards</h2>
          {/* The outage email says "open the Devices page" and watch the box come back, so
              the page has to be able to say when it last looked and to look again on
              demand — the Bookings screen has had a Refresh button all along, and it is
              far less time-critical than this one. */}
          <Button
            variant="outline"
            className="ml-auto min-h-11 px-3 text-sm"
            onClick={() => void refreshNow()}
            disabled={refreshing || loading}
          >
            {refreshing ? "Checking…" : "Refresh"}
          </Button>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          {checkedAt ? `Checked ${relative(checkedAt, now)}` : "Checking…"} · this page re-reads the boards every {REFRESH_MS / 1000} seconds while this tab is in front.
        </p>

        <UnacknowledgedBoardsNotice devices={devices} />

        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : devices.length === 0 ? (
          /* A club may own only doors: a gate registers itself on this list exactly as a box
             does, so "no boxes" told such a club its doors did not count as devices. The
             heading above is already "Connected boards". */
          <p className="text-sm text-slate-500">
            No boards have called in yet. Flash one with the key above and power it on — it registers itself.
          </p>
        ) : (
          <>
            <div className="space-y-3">
              {boxes.map((device) => {
                // One coverage per row: the confirm, the notice and the toast all read it.
                const coverage = coverageWithout(device, devices,
                  (d) => isOnline(d, offlineAfterSecondsFor(d, tenantHeartbeat), now));
                return (
                  <DeviceRow
                    key={device.id} device={device}
                    boxEditing={{ courts, clubMap: buttonMap, walkUpMax: walkUpCap }}
                    actions={actionsFor(device, coverage)} coverage={coverage}
                    liveness={{ offlineAfter: offlineAfterSecondsFor(device, tenantHeartbeat), now }}
                  />
                );
              })}
            </div>
            {/* A2.5: gates are VISIBLE here and editable only on Doors. */}
            <GateRows gates={gates} tenantHeartbeat={tenantHeartbeat} now={now} />
          </>
        )}
      </Card>

      <ClubButtonMapCard
        settings={settings} value={buttonMap} onChange={setButtonMap}
        loading={loading} walkUpCap={walkUpCap}
      />
    </div>
  );
}
