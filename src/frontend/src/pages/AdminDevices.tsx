import { useCallback, useEffect, useState } from "react";
import { Cpu, Wifi, WifiOff } from "lucide-react";
import { endpoints, isGate, type AdminCourt, type AdminDevice, type AdminSettings } from "../lib/api";
import { describeDeviceError } from "../lib/deviceErrors";
import {
  coverageWithout, outOfServiceConfirm, outOfServiceConsequences, type CourtCoverage,
} from "../lib/deviceCoverage";
import {
  GATE_KEY_MAX_LENGTH, NEW_GATE_BADGE, describeGate, gateDeleteConfirm,
  gateOutOfServiceConfirm, gateOutOfServiceNotice, unnamedGateOfflineNotice,
} from "../lib/gateCopy";
import { Card } from "../components/Card";
import { Badge, Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { ButtonMapEditor, buttonMapWithinCap, MAX_GRANT_MINUTES, RELAYS } from "../components/ButtonMapEditor";
import { ClubButtonMapCard, WalkUpCapNotice } from "../components/ClubButtonMapCard";
import { DeviceApiKeyPanel } from "../components/DeviceApiKeyPanel";
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
 * The heartbeat interval a box will actually run, whatever the tenant setting says.
 *
 * <p>
 * The firmware clamps its cadence to this range (`Cadence.h`), so a club that sets 600
 * has boxes calling in every 300 and a club that sets 5 has them calling in every 15.
 * Reading the raw setting as if it were the interval is how "offline" gets decided
 * against a number no box is using.
 * </p>
 */
const HEARTBEAT_MIN_S = 15;
const HEARTBEAT_MAX_S = 300;

/** What a box runs when nothing says otherwise — the tenant default. */
const HEARTBEAT_FALLBACK_S = 60;

/**
 * Missed beats before a box is called offline, when the API does not say.
 *
 * <p>
 * Three, so one slow request or one dropped datagram is not an outage. It used to be
 * three beats of an assumed 30-second cadence, frozen as a literal 180 000 ms — and the
 * settings page then grew an editable interval offering up to 3600 s, at which point a
 * club that raised it to reduce chatter watched the whole fleet read offline for most
 * of every interval and started power-cycling boxes mid-league-night (review finding 22).
 * The threshold is the API's own `offline_after_seconds` where it is sent, and derived
 * from the cadence the box actually runs where it is not.
 * </p>
 */
const MISSED_BEATS_BEFORE_OFFLINE = 3;

/**
 * How often the page re-reads the boxes, milliseconds.
 *
 * <p>
 * This screen's entire content is liveness — "online" / "last seen Nm ago" — and the
 * peripheral-health email tells an admin to open it and watch a box recover. It loaded once
 * on mount and never again, so the page the alert LINKS TO showed the state at the moment
 * it was opened: a tab left open read "online" for a box six and a half minutes dark, more
 * than double the offline threshold and long after the club had been emailed about it,
 * while a second tab on the same URL opened two seconds later read "last seen 6m ago"
 * (finding M-F2).
 * </p>
 *
 * <p>
 * Fifteen seconds is the firmware's own minimum heartbeat interval
 * (`bridgelogic::kMinHeartbeatMs`, mirrored in HEARTBEAT_MIN_S above), so the page cannot
 * be more than one beat behind the fastest box a club can configure. Only the device list
 * is re-read; the settings and courts behind it change when an admin changes them.
 * </p>
 */
const REFRESH_MS = 15_000;

/** How long since the last beat before this box counts as offline, seconds. */
function offlineAfterSeconds(device: AdminDevice, tenantSeconds: number | null): number {
  if (device.offline_after_seconds) return device.offline_after_seconds;
  const declared = device.effective_heartbeat_seconds ?? tenantSeconds ?? HEARTBEAT_FALLBACK_S;
  const clamped = Math.min(Math.max(declared, HEARTBEAT_MIN_S), HEARTBEAT_MAX_S);
  return clamped * MISSED_BEATS_BEFORE_OFFLINE;
}

function isOnline(device: AdminDevice, offlineAfter: number) {
  if (!device.last_seen_at) return false;
  return Date.now() - new Date(device.last_seen_at).getTime() < offlineAfter * 1000;
}

function relative(iso: string | null) {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

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
              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm disabled:opacity-50"
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
        <Button className="h-8 px-3 text-xs" onClick={() => void save()} disabled={saving || (own && !buttonMapWithinCap(draft))}>
          {saving ? "Saving…" : "Save buttons"}
        </Button>
        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

// --- one board in the list --------------------------------------------------

/** Everything a row can ask the page to do to its device. */
type DeviceActions = {
  details: (name: string, courtNumbers: number[]) => Promise<boolean>;
  /**
   * A gate's half of `details`: its name and the door it is on. Never sent for a box.
   * `gateKey` is `""` to clear the door's name — see {@link GateDetailsEditor}.
   */
  gateDetails: (name: string, gateKey: string) => Promise<boolean>;
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
        <Button className="h-8 px-3 text-xs" onClick={() => void save()} disabled={saving || draft.length === 0}>
          {saving ? "Saving…" : "Save box"}
        </Button>
        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

/**
 * A door's name and its gate key, saved together.
 *
 * <p>
 * The same one-save argument as {@link DeviceDetailsEditor}: a gate arrives named "Door
 * gate" with no key at all, so both are wrong at the same moment and splitting them would
 * be two saves and two chances to clear the "New" badge with half the job done.
 * </p>
 *
 * <p>
 * There is no court list and no button map here, and their absence is the point rather
 * than an omission: the API refuses either on a Gate row outright, so an editor offering
 * them would be a form whose save can only fail.
 * </p>
 */
function GateDetailsEditor({
  device, onSave, onClose,
}: {
  device: AdminDevice;
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
  const nameId = `${device.id}-name`;
  const keyId = `${device.id}-gate-key`;

  async function save() {
    setSaving(true);
    try {
      // Trimmed here as well as on the API, so the row that comes back is the row the
      // admin will see — a key saved with a trailing space would otherwise render with an
      // invisible difference from the one they typed. An empty field goes as `""`, which
      // is the API's clear; it used to go as `null`, which the API discards.
      if (await onSave(name.trim() || device.name, key.trim())) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3">
      <div>
        <Label htmlFor={nameId}>Name</Label>
        <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="Door gate" disabled={saving} />
      </div>
      <div>
        <Label htmlFor={keyId}>Door name</Label>
        {/* NOT "the only thing that tells one door from another": a gate decision is audited
            with the board's device code as well as its gate key, and the code is per board.
            What is true, and what an admin needs, is that the code is a fragment of a MAC
            address — so without a name here the audit trail identifies the door by something
            nobody can match to a corridor without walking to it. */}
        <p className="mb-2 text-xs text-slate-500">
          Which door this board is on. Every door runs the same firmware and nothing is
          compiled in per door, so this is how the audit trail names the door. Without it a
          scan is recorded against the board code alone. Leave it empty to take the name away
          again. {unnamedGateOfflineNotice()}
        </p>
        <Input
          id={keyId}
          value={key}
          // The API's own bound, on the field, so a long name is stopped where it is typed
          // rather than after a save the admin has to decode.
          maxLength={GATE_KEY_MAX_LENGTH}
          onChange={(e) => setKey(e.target.value)}
          placeholder="front-door"
          disabled={saving}
        />
      </div>
      <div className="flex gap-2">
        <Button className="h-8 px-3 text-xs" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save door"}
        </Button>
        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

/** The badges and the identity line — everything about a row that is read-only. */
function DeviceRowHeader({ device, online }: { device: AdminDevice; online: boolean }) {
  const isBox = !isGate(device);
  // Presence-gated AND kind-gated: a gate has no buttons, so the override badge cannot be
  // true of one however the payload is shaped.
  const hasOwnMapField = isBox && device.button_map !== undefined;
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
              {online ? "online" : `not reporting — last seen ${relative(device.last_seen_at)}`}
            </Badge>
          )}
        {/* A box registers itself with a generated name and default courts. Until an
            admin has looked, the club has a live box whose relays probably point at the
            wrong courts — which is a league night with the wrong lights on, not a
            cosmetic gap. The badge clears when the row is edited.

            A gate is the same badge and a different job: it registers with no courts at
            all and no door name, so telling its admin to "check court numbers" would send
            them looking for an editor this row does not have and must not have. What a
            new door needs is a name — until it has one, every audit row for a scan at it
            carries a null gate_key and names the door only by its board code, which is a
            fragment of a MAC address. */}
        {device.auto_registered && (
          <Badge tone="warning">{isBox ? "New — check court numbers" : NEW_GATE_BADGE}</Badge>
        )}
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
 * What an unnamed door cannot do, on the row rather than only inside the editor.
 *
 * <p>
 * A gate whose `gate_key` is null is sent an empty roster on every heartbeat, so it has no
 * offline fallback at all. That is a functional gap rather than a cosmetic one, and the
 * badge beside it says only that the row is NEW — a different claim, and one that stops
 * being true the moment anything on the row is edited.
 * </p>
 *
 * <p>
 * Keyed on the name being absent rather than on `auto_registered`, because clearing a name
 * takes the roster away from a row that is no longer new. Its own component rather than a
 * conditional inside {@link DeviceRow}, which the complexity gate already holds at its
 * bound — and because the condition is then stated once, beside the reason for it.
 * </p>
 *
 * <p>
 * Silent while the door editor is open, because the field's own hint carries the same
 * sentence there and the two render one above the other. Seen at phone width: the identical
 * paragraph twice inside one card, which reads as a rendering fault rather than as emphasis.
 * </p>
 */
function UnnamedGateNotice({ device, editing }: { device: AdminDevice; editing: boolean }) {
  if (editing) return null;
  if (!isGate(device) || device.gate_key !== null) return null;
  return (
    <p className="mt-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
      {unnamedGateOfflineNotice()}
    </p>
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
 * <b>The GATE branch shares none of those words, on purpose.</b> A door drives no courts, so
 * every clause above about a court going dark and its no-shows being waived is simply not
 * true of one, and letting the box copy render on a gate row would have told a club its
 * refunds had changed when nothing had. The gate's own sentence is generated by
 * {@link gateOutOfServiceNotice}, which the toast reads too.
 * </p>
 */
function OutOfServiceNotice({ device, coverage }: { device: AdminDevice; coverage: CourtCoverage }) {
  return (
    <p className="mt-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
      {isGate(device)
        ? `Out of service. ${gateOutOfServiceNotice()}`
        : "Out of service. The API refuses this box, so it switches nothing on, and the club is not"
          + ` alerted about its silence. ${outOfServiceConsequences(coverage).join(" ")}`}
    </p>
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

function DeviceRow({
  device, boxEditing, actions, offlineAfter, coverage,
}: {
  device: AdminDevice;
  boxEditing: BoxEditing;
  actions: DeviceActions;
  /** Seconds since the last beat before this board is offline. See offlineAfterSeconds. */
  offlineAfter: number;
  /** What each of this box's courts would be left with without it. See lib/deviceCoverage. */
  coverage: CourtCoverage;
}) {
  const online = isOnline(device, offlineAfter);
  const [editing, setEditing] = useState<"details" | "buttons" | null>(null);
  const isBox = !isGate(device);
  // Presence-gated AND kind-gated: an API that does not send the field gets no editor for
  // it, and a gate has no buttons to edit however the payload is shaped.
  const hasOwnMapField = isBox && device.button_map !== undefined;

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <DeviceRowHeader device={device} online={online} />

      {editing === "details" && (isBox
        ? <DeviceDetailsEditor device={device} courts={boxEditing.courts} onSave={actions.details} onClose={() => setEditing(null)} />
        : <GateDetailsEditor device={device} onSave={actions.gateDetails} onClose={() => setEditing(null)} />
      )}

      {editing === "buttons" && isBox && (
        <DeviceButtonMapPanel
          device={device}
          clubMap={boxEditing.clubMap}
          walkUpMax={boxEditing.walkUpMax}
          onSave={actions.buttonMap}
          onClose={() => setEditing(null)}
        />
      )}

      <UnnamedGateNotice device={device} editing={editing === "details"} />

      {!device.enabled && <OutOfServiceNotice device={device} coverage={coverage} />}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {editing === null && (
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={() => setEditing("details")}>
            {isBox ? "Edit name and courts" : "Edit name and door"}
          </Button>
        )}

        {isBox && hasOwnMapField && editing === null && (
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={() => setEditing("buttons")}>
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

            A gate gets the same control and a different label, because none of the above is
            what it costs: no court goes dark, no penalty is waived, and the honest caveat is
            the opposite one — the door may keep opening from its cached roster for a while
            after the API stops answering it. See gateOutOfServiceConfirm in lib/gateCopy. */}
        {device.enabled ? (
          <ConfirmButton
            idleLabel="Take out of service"
            // The confirm names the consequence that is hardest to undo knowing about, per
            // court and only where it is true — see outOfServiceConfirm in lib/deviceCoverage.
            // An admin taking a
            // spare out of service beside a box that is reporting gets the plain sentence.
            confirmLabel={isBox ? outOfServiceConfirm(coverage) : gateOutOfServiceConfirm()}
            onConfirm={() => actions.setEnabled(false)}
            className="h-8 px-3"
          />
        ) : (
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={() => void actions.setEnabled(true)}>
            Put back in service
          </Button>
        )}

        {/* Deleting is not a revocation and locks nothing out — the box still holds the
            club's key. It forgets the row, and the box makes a new one on its next call.
            The confirm label says exactly that, because "Really delete?" would let an
            admin think they had just taken a box off the network.

            For a gate it is also the only way to change a row's kind, and what comes back
            is a door with no name — so its label says that instead. */}
        <ConfirmButton
          idleLabel="Delete"
          confirmLabel={isBox ? "Delete? The box re-registers on its next heartbeat." : gateDeleteConfirm()}
          onConfirm={actions.remove}
          idleClassName="bg-danger-soft text-danger-strong hover:bg-danger-soft/70"
          className="h-8 px-3"
        />
      </div>
    </div>
  );
}

// --- the page ---------------------------------------------------------------

/**
 * What the toast says after the out-of-service switch is thrown, either way.
 *
 * <p>
 * The out-of-service half is the SAME generator the row notice above renders — for a box
 * {@link outOfServiceConsequences}, for a gate {@link gateOutOfServiceNotice} — because
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
  if (isGate(device)) {
    return enabled
      ? `${device.name} is back in service. Scans at it are answered again from its next call, and the club is alerted if it goes quiet.`
      : `${device.name} is out of service. ${gateOutOfServiceNotice()}`;
  }
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
  const comesBack = isGate(device)
    ? "as a new door with no name"
    : "as a new box";
  return `${device.name} deleted. It still has the club's key, so it re-registers on its next heartbeat ${comesBack} — unplug it if you meant to retire it.`;
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
    /**
     * A door's name and key, in one PATCH.
     *
     * <p>
     * `gate_key` does NOT bind three-valued the way `button_map` does, which is what this
     * comment used to say and what the code did: clearing a door's name is `""` on the wire,
     * because the API applies the field only when it is not null and reads an empty string
     * as the clear. Sending `null` was a silent no-op that reported success.
     * </p>
     *
     * <p>
     * `court_numbers` is never sent, because the API refuses it on a Gate row.
     * </p>
     */
    gateDetails: async (name, gateKey) => {
      try {
        await endpoints.adminDeviceUpdate(device.id, { name, gate_key: gateKey });
        toast.push({
          tone: "success",
          // A cleared name is not a cosmetic loss any more: an unnamed gate is sent an empty
          // roster, so it stops working the moment it loses the network. The toast used to
          // say "scans at it still work", which is true only while the API is reachable.
          text: gateKey === ""
            ? `${name} has no door name. ${unnamedGateOfflineNotice()} The audit trail cannot say which door a scan was, either.`
            : `${name} is the ${gateKey} door. It picks that up on its next heartbeat.`,
        });
        await reload();
        return true;
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not save that door."), durationMs: 8000 });
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

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      <h1 className="text-2xl font-bold">Devices</h1>

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
            className="ml-auto h-8 px-3 text-xs"
            onClick={() => void refreshNow()}
            disabled={refreshing || loading}
          >
            {refreshing ? "Checking…" : "Refresh"}
          </Button>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          {checkedAt ? `Checked ${relative(checkedAt)}` : "Checking…"} · this page re-reads the boards every {REFRESH_MS / 1000} seconds while this tab is in front.
        </p>

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
          <div className="space-y-3">
            {devices.map((device) => {
              // One coverage per row: the confirm, the notice and the toast all read it.
              const coverage = coverageWithout(device, devices,
                (d) => isOnline(d, offlineAfterSeconds(d, tenantHeartbeat)));
              return (
                <DeviceRow
                  key={device.id} device={device}
                  boxEditing={{ courts, clubMap: buttonMap, walkUpMax: walkUpCap }}
                  actions={actionsFor(device, coverage)} coverage={coverage}
                  offlineAfter={offlineAfterSeconds(device, tenantHeartbeat)}
                />
              );
            })}
          </div>
        )}
      </Card>

      <ClubButtonMapCard
        settings={settings} value={buttonMap} onChange={setButtonMap}
        loading={loading} walkUpCap={walkUpCap}
      />
    </div>
  );
}
