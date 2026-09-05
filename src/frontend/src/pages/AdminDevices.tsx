import { useCallback, useEffect, useState } from "react";
import { Cpu, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { endpoints, type AdminCourt, type AdminDevice, type AdminSettings } from "../lib/api";
import { describeDeviceError } from "../lib/deviceErrors";
import { Card } from "../components/Card";
import { Badge, Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { ButtonMapEditor, buttonMapWithinCap, RELAYS } from "../components/ButtonMapEditor";
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
  device, clubMap, onSave, onClose,
}: {
  device: AdminDevice;
  clubMap: string[];
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
        {online
          ? <Wifi className="h-4 w-4 text-emerald-500" aria-label="online" />
          : <WifiOff className="h-4 w-4 text-slate-300" aria-label="offline" />}
        <span className="font-medium">{device.name}</span>
        <Badge tone={online ? "success" : "muted"}>
          {online ? "online" : `last seen ${relative(device.last_seen_at)}`}
        </Badge>
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
  device, courts, clubMap, actions, offlineAfter,
}: {
  device: AdminDevice;
  courts: AdminCourt[];
  clubMap: string[];
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
        <DeviceButtonMapPanel device={device} clubMap={clubMap} onSave={actions.buttonMap} onClose={() => setEditing(null)} />
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
    setLoading(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- as above
  useEffect(() => { void load(); }, [load]);

  const actionsFor = useDeviceActions(load);

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
        <div className="mb-3 flex items-center gap-2">
          <Cpu className="h-5 w-5 text-slate-400" />
          <h2 className="text-lg font-semibold">Connected boards</h2>
        </div>

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

        <div className="mt-4">
          <Button onClick={() => void saveButtonMap()} disabled={savingMap || loading || !buttonMapWithinCap(buttonMap)}>
            {savingMap ? "Saving…" : "Save button map"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
