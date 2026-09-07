import { useCallback, useEffect, useState } from "react";
import { Cpu, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { endpoints, type AdminCourt, type AdminDevice, type AdminSettings } from "../lib/api";
import { describeDeviceError } from "../lib/deviceErrors";
import { Card } from "../components/Card";
import { Badge, Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { ButtonMapEditor, buttonMapWithinCap, MAX_GRANT_MINUTES, RELAYS } from "../components/ButtonMapEditor";
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

/** The grant a `minutes:N` button makes, or null for any other action. */
function grantMinutes(wire: string): number | null {
  const text = wire.trim().toLowerCase();
  if (!text.startsWith("minutes:")) return null;
  const minutes = Number(text.slice(8) || "15");
  return Number.isFinite(minutes) ? minutes : null;
}

/** The 1-based button numbers in this map that grant more than `cap` minutes. */
function buttonsOverCap(map: string[], cap: number): number[] {
  const over: number[] = [];
  map.forEach((wire, index) => {
    const minutes = grantMinutes(wire);
    if (minutes !== null && minutes > cap) over.push(index + 1);
  });
  return over;
}

/**
 * Says which minute buttons the club's own walk-up maximum will refuse.
 *
 * <p>
 * The editor validates against the relay hard cap of 90 and nothing else, so lowering
 * `walk_up_max_minutes` to 20 left every box still advertising 15/30/45/60 while the API
 * refused three of the four presses with `minutes_out_of_range` — the club's own
 * configuration change, blamed on the member, at a court with nobody at the desk
 * (finding M-F1). The word "walk-up" did not appear on this page at all.
 * </p>
 *
 * <p>
 * A warning rather than a refusal: the cap can be raised afterwards, and a button map that
 * anticipates that is not wrong. Blocking the save would also deadlock the two screens
 * against each other.
 * </p>
 */
function WalkUpCapNotice({ map, cap }: { map: string[]; cap: number | null }) {
  if (cap === null) return null;
  const over = buttonsOverCap(map, cap);
  if (over.length === 0) return null;

  const one = over.length === 1;
  return (
    <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
      {one ? `Button ${over[0]} grants` : `Buttons ${over.join(", ")} grant`} more than this club's
      walk-up maximum of {cap} minutes, so the box refuses {one ? "that press" : "those presses"} and
      sends the member to the desk. Raise <b>Walk-up maximum (minutes)</b> under Admin settings, or
      lower {one ? "the button" : "the buttons"}.
    </p>
  );
}

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

/** The badges and the identity line — everything about a row that is read-only. */
function DeviceRowHeader({ device, online }: { device: AdminDevice; online: boolean }) {
  const isBox = device.kind !== "Gate";
  const hasOwnMapField = device.button_map !== undefined;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {device.enabled && online
          ? <Wifi className="h-4 w-4 text-emerald-500" aria-label="online" />
          : <WifiOff className="h-4 w-4 text-slate-300" aria-label={device.enabled ? "offline" : "out of service"} />}
        <span className="font-medium">{device.name}</span>
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
            cosmetic gap. The badge clears when the row is edited. */}
        {device.auto_registered && <Badge tone="warning">New — check court numbers</Badge>}
        {hasOwnMapField && device.button_map != null && <Badge tone="info">own button map</Badge>}
      </div>

      <div className="mt-1 text-xs text-slate-500">
        {device.device_code}
        {isBox ? ` · ${describeCourts(device.court_numbers)}` : (device.gate_key ? ` · gate ${device.gate_key}` : "")}
        {device.mac_address ? ` · ${device.mac_address}` : ""}
        {device.last_ip_address ? ` · ${device.last_ip_address}` : ""}
        {device.running_version ? ` · firmware ${device.running_version}` : ""}
        {device.mega_version ? ` · Mega ${device.mega_version}` : ""}
      </div>
    </>
  );
}

function DeviceRow({
  device, courts, clubMap, walkUpMax, actions, offlineAfter,
}: {
  device: AdminDevice;
  courts: AdminCourt[];
  clubMap: string[];
  /** The club's walk-up maximum, for the button-map notice. */
  walkUpMax: number | null;
  actions: DeviceActions;
  /** Seconds since the last beat before this box is offline. See offlineAfterSeconds. */
  offlineAfter: number;
}) {
  const online = isOnline(device, offlineAfter);
  const [editing, setEditing] = useState<"details" | "buttons" | null>(null);
  const isBox = device.kind !== "Gate";
  // Presence-gated: an API that does not send the field gets no editor for it.
  const hasOwnMapField = device.button_map !== undefined;

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <DeviceRowHeader device={device} online={online} />

      {editing === "details" && (
        <DeviceDetailsEditor device={device} courts={courts} onSave={actions.details} onClose={() => setEditing(null)} />
      )}

      {editing === "buttons" && (
        <DeviceButtonMapPanel
          device={device}
          clubMap={clubMap}
          walkUpMax={walkUpMax}
          onSave={actions.buttonMap}
          onClose={() => setEditing(null)}
        />
      )}

      {/* What "out of service" actually means, said on the rows where it is in force
          rather than buried in a tooltip. All three sentences are things the code does:
          DeviceIdentity refuses a disabled box 403 on every endpoint,
          PeripheralHealthWorker filters `d.Enabled`, and DeviceOutageIndex builds its
          silence index from the enabled boxes alone. */}
      {!device.enabled && (
        <p className="mt-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          Out of service. The API refuses this box, so it switches nothing on; the club is not
          alerted about its silence; and {describeCourts(device.court_numbers)} are judged by whatever
          other boxes drive them.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {isBox && editing === null && (
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={() => setEditing("details")}>
            Edit name and courts
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
            back, because restoring a box is not a decision anyone regrets. */}
        {device.enabled ? (
          <ConfirmButton
            idleLabel="Take out of service"
            confirmLabel="Out of service? The box stops switching lights on."
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
            admin think they had just taken a box off the network. */}
        <ConfirmButton
          idleLabel="Delete"
          confirmLabel="Delete? The box re-registers on its next heartbeat."
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
 * The mutations a row can ask for, built per device. Kept out of the page component
 * so the page stays a loader and a layout.
 */
function useDeviceActions(reload: () => Promise<void>) {
  const toast = useToast();

  return (device: AdminDevice): DeviceActions => ({
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
     * since the row existed and nothing ever sent it — the two mutations above send
     * `{name, court_numbers}` and `{button_map}` and nothing else.
     */
    setEnabled: async (enabled) => {
      try {
        await endpoints.adminDeviceUpdate(device.id, { enabled });
        toast.push({
          tone: "success",
          // Both sentences are consequences the code actually has: the health sweep
          // filters on Enabled, and so does the silence index the no-show waiver reads.
          text: enabled
            ? `${device.name} is back in service. It works again on its next call, and the club is alerted if it goes quiet.`
            : `${device.name} is out of service. It switches nothing on, the club is not alerted about it, and its courts are judged by whatever other boxes drive them.`,
          durationMs: 8000,
        });
        await reload();
      } catch (e) {
        toast.push({
          tone: "danger",
          text: describeDeviceError(e, enabled ? "Could not put that box back in service." : "Could not take that box out of service."),
          durationMs: 8000,
        });
      }
    },
    remove: async () => {
      try {
        await endpoints.adminDeviceDelete(device.id);
        toast.push({
          tone: "success",
          text: `${device.name} deleted. It still has the club's key, so it re-registers on its next heartbeat as a new box — unplug it if you meant to retire it.`,
          durationMs: 8000,
        });
        await reload();
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not delete that box.") });
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
  const [savingMap, setSavingMap] = useState(false);
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
    const timer = setInterval(() => { void refreshDevices().catch(() => {}); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshDevices]);

  async function refreshNow() {
    setRefreshing(true);
    try {
      await refreshDevices();
    } catch (e) {
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not re-read the boxes.") });
    } finally {
      setRefreshing(false);
    }
  }

  const actionsFor = useDeviceActions(load);

  // The bound a minute button is actually held to: the club's own walk-up maximum, never
  // above the relay's hard cap. The editor already refuses anything past the hard cap; the
  // club's cap is the half nothing on this page knew about.
  const walkUpCap = settings ? Math.min(settings.walk_up_max_minutes, MAX_GRANT_MINUTES) : null;

  async function saveButtonMap() {
    if (!settings) return;
    setSavingMap(true);
    try {
      // The button map, and the eight booking fields the API requires on every PUT.
      // Nothing else.
      //
      // This used to spread the whole settings document read at mount — and "present as
      // read" is not a no-op, it is a write of a value that may be minutes stale. An
      // admin raising the code lifetime in another tab had it reverted the moment this
      // screen saved a remapped button, silently, and the comment here claimed the
      // opposite (review finding 23). Re-GETting immediately before the PUT would only
      // narrow that window, not close it — the race moves into the gap between the two
      // calls — and it still writes twenty keys this screen does not own. Sending only
      // what this screen owns cannot revert anything, because the API reads an absent
      // key as unchanged. The eight below are not optional on the API and are the
      // booking form's, not this one's; they are the price of there being no PATCH.
      await endpoints.adminSettingsSave({
        slice_minutes: settings.slice_minutes,
        slice_price_credits: settings.slice_price_credits,
        advance_booking_days: settings.advance_booking_days,
        day_start_minute: settings.day_start_minute,
        day_end_minute: settings.day_end_minute,
        penalty_pct: settings.penalty_pct,
        grace_window_minutes: settings.grace_window_minutes,
        penalty_window_minutes: settings.penalty_window_minutes,
        button_map: buttonMap,
      });
      toast.push({ tone: "success", text: "Button map saved. Boxes pick it up on their next heartbeat." });
    } catch (e) {
      // The server checks the map against every box's court list and names the one
      // that cannot honour it. That sentence is the whole point of the refusal.
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not save the button map."), durationMs: 8000 });
    } finally {
      setSavingMap(false);
    }
  }

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
          {checkedAt ? `Checked ${relative(checkedAt)}` : "Checking…"} · this page re-reads the boxes every {REFRESH_MS / 1000} seconds.
        </p>

        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="text-sm text-slate-500">
            No boxes have called in yet. Flash one with the key above and power it on — it registers itself.
          </p>
        ) : (
          <div className="space-y-3">
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                courts={courts}
                clubMap={buttonMap}
                walkUpMax={walkUpCap}
                actions={actionsFor(device)}
                offlineAfter={offlineAfterSeconds(device, settings?.heartbeat_seconds ?? null)}
              />
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-1 flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-slate-400" />
          <h2 className="text-lg font-semibold">Button map</h2>
        </div>
        <p className="mb-4 text-sm text-slate-500">
          What each of the eight buttons on a court box does. The wiring never changes — button 1 is always
          the same physical button — so you can swap courts around here without anyone touching the hardware.
          "Court A" means whatever court is on relay A of the box being pressed. Boxes pick up a change on their
          next heartbeat. A box given its own map above ignores this one.
        </p>

        <ButtonMapEditor value={buttonMap} onChange={setButtonMap} disabled={savingMap || loading} />

        <WalkUpCapNotice map={buttonMap} cap={walkUpCap} />

        <div className="mt-4">
          <Button onClick={() => void saveButtonMap()} disabled={savingMap || loading || !buttonMapWithinCap(buttonMap)}>
            {savingMap ? "Saving…" : "Save button map"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
