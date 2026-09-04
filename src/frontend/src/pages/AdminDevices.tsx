import { useCallback, useEffect, useMemo, useState } from "react";
import { Cpu, KeyRound, Radio, RefreshCw, Wifi, WifiOff } from "lucide-react";
import {
  ApiError,
  endpoints,
  type AdminCourt,
  type AdminDevice,
  type AdminSettings,
  type DeviceHardware,
  type DiscoveredBoard,
  type DiscoveryStatus,
  type OtaChannel,
} from "../lib/api";
import { Card } from "../components/Card";
import { Badge, Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { useToast } from "../components/Toast";
import { cn } from "../lib/utils";

/**
 * Devices — the screen that had eight live endpoints and no way to reach them.
 *
 * Three jobs, in the order an admin does them: connect a board that has just been
 * plugged in, see what the fleet is doing, and decide what the buttons on it mean.
 *
 * A court box drives up to four courts, one per relay. The relay letters A–D are the
 * physical outputs; which court sits on each is decided here, in relay order, and the
 * tenant's button map addresses courts by that same letter. The two are checked against
 * each other on every save — from either screen — so a button can never select a relay
 * the box does not have a court on.
 */

/** A device that has not called in for this long is shown as offline. Mirrors
 *  DeviceEndpoints.OfflineAfterSeconds on the server; a box heartbeats every 30s,
 *  so three missed beats is a real absence rather than one slow request. */
const OFFLINE_AFTER_MS = 180_000;

/** The relay bank on a court box, in the order `court_numbers` is indexed. */
const RELAYS = ["A", "B", "C", "D"] as const;

function isOnline(device: AdminDevice) {
  if (!device.last_seen_at) return false;
  return Date.now() - new Date(device.last_seen_at).getTime() < OFFLINE_AFTER_MS;
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

/** The suggested device code for a box, from the courts it drives: `court-box-1-2`. */
function suggestDeviceCode(courtNumbers: number[]) {
  return courtNumbers.length === 0 ? "court-box" : `court-box-${courtNumbers.join("-")}`;
}

// --- errors -------------------------------------------------------------------

/**
 * Turns an API refusal into a sentence an admin can act on.
 *
 * The server answers with a stable `error` token, and for the button-map mismatch it
 * also names the box, the relay index the map reaches for and how many courts the box
 * has — because the fix is on one of two screens and the message has to say which.
 * Anything unrecognised falls back to the server's own `message`, then the token.
 */
const DEVICE_ERROR_TEXT: Record<string, string> = {
  court_numbers_required_for_court_box: "A court box needs at least one court. Pick the court on relay A.",
  too_many_courts_for_relay_bank: `A box drives at most ${RELAYS.length} courts — one per relay, A to D.`,
  duplicate_court_numbers: "Each court can be on only one relay. Two relays point at the same court.",
  device_code_taken: "That device code is already in use. Pick another.",
};

const MAP_MISMATCH_GENERIC =
  "The button map selects a court this box does not drive. Give the box more courts, or change the button map first.";

function describeMapMismatch(payload: Record<string, unknown>): string {
  const index = typeof payload.court_index === "number" ? payload.court_index : null;
  const count = typeof payload.device_court_count === "number" ? payload.device_court_count : null;
  const box = typeof payload.device_code === "string" ? payload.device_code : null;
  if (index === null || count === null || box === null) return MAP_MISMATCH_GENERIC;
  const relay = RELAYS[index] ?? `#${index + 1}`;
  const plural = count === 1 ? "" : "s";
  return `The button map selects court ${relay}, but ${box} drives only ${count} court${plural}. `
    + "Give the box more courts, or change the button map first.";
}

function describeDeviceError(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return e instanceof Error && e.message ? e.message : fallback;
  const payload = typeof e.payload === "object" && e.payload !== null ? (e.payload as Record<string, unknown>) : {};
  const code = typeof payload.error === "string" ? payload.error : null;
  if (code === "button_map_selects_court_beyond_device_courts") return describeMapMismatch(payload);
  if (code !== null && code in DEVICE_ERROR_TEXT) return DEVICE_ERROR_TEXT[code];
  if (typeof payload.message === "string" && payload.message) return payload.message;
  return code ? code.replace(/_/g, " ") : fallback;
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

// --- button map editor ------------------------------------------------------

const BUTTON_COUNT = 8;

type ActionKind = "court" | "minutes" | "off" | "none";

/** Parses a wire token for display. Mirrors the grammar in
 *  src/contracts/device-protocol/buttonmap/cases.json — the file both the API and
 *  the firmware read, so that this editor cannot invent a token neither accepts. */
function parseAction(wire: string): { kind: ActionKind; value: string } {
  const text = wire.trim().toLowerCase();
  if (text === "off") return { kind: "off", value: "" };
  if (text.startsWith("court:")) return { kind: "court", value: text.slice(6).toUpperCase() };
  if (text.startsWith("minutes:")) return { kind: "minutes", value: text.slice(8) };
  return { kind: "none", value: "" };
}

function toWire(kind: ActionKind, value: string) {
  if (kind === "court") return `court:${value || "A"}`;
  if (kind === "minutes") return `minutes:${value || "15"}`;
  return kind;
}

function ButtonMapEditor({
  value, onChange, disabled,
}: { value: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const rows = useMemo(() => {
    const padded = [...value];
    while (padded.length < BUTTON_COUNT) padded.push("none");
    return padded.slice(0, BUTTON_COUNT);
  }, [value]);

  function update(index: number, kind: ActionKind, detail: string) {
    const next = [...rows];
    next[index] = toWire(kind, detail);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {rows.map((wire, index) => {
        const { kind, value: detail } = parseAction(wire);
        return (
          <div key={index} className="flex items-center gap-2">
            {/* The label is the PHYSICAL button, always. Button 1 is the one on pin 22
                whatever it now does — that is what makes remapping mean anything. */}
            <span className="w-20 shrink-0 text-sm text-slate-500">Button {index + 1}</span>

            <select
              aria-label={`Button ${index + 1} action`}
              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm"
              value={kind}
              disabled={disabled}
              onChange={(e) => update(index, e.target.value as ActionKind, "")}
            >
              <option value="court">Select court</option>
              <option value="minutes">Grant minutes</option>
              <option value="off">Turn off</option>
              <option value="none">Unused</option>
            </select>

            {kind === "court" && (
              <select
                aria-label={`Button ${index + 1} court`}
                className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm"
                value={detail || "A"}
                disabled={disabled}
                onChange={(e) => update(index, "court", e.target.value)}
              >
                {RELAYS.map((c) => <option key={c} value={c}>Court {c}</option>)}
              </select>
            )}

            {kind === "minutes" && (
              <Input
                aria-label={`Button ${index + 1} minutes`}
                type="number"
                min={1}
                max={240}
                className="h-9 w-24"
                value={detail || "15"}
                disabled={disabled}
                onChange={(e) => update(index, "minutes", e.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- connect a board --------------------------------------------------------

function ConnectBoard({ courts, onClaimed }: { courts: AdminCourt[]; onClaimed: () => void }) {
  const toast = useToast();
  const [boards, setBoards] = useState<DiscoveredBoard[]>([]);
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const [name, setName] = useState("");
  const [courtNumbers, setCourtNumbers] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [found, state] = await Promise.all([
      endpoints.adminDevicesDiscovered(),
      endpoints.adminDiscoveryStatus(),
    ]);
    setBoards(found);
    setStatus(state);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom in every other admin page here
    void refresh();
    // Boards announce every few seconds, and an admin is standing at the cupboard
    // waiting for one to appear. Polling is the honest mechanism here: there is no
    // push channel to the browser and a manual refresh button would have them
    // clicking it.
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function claim() {
    if (!selected) return;
    setBusy(true);
    try {
      // The board is matched on the server by its commitment to the code, not by the
      // MAC picked here — picking one is how the admin knows which LCD to read.
      const result = await endpoints.adminDeviceClaim({
        claimCode: code.trim().toUpperCase(),
        deviceCode: deviceCode.trim() || suggestDeviceCode(courtNumbers),
        name: name.trim() || `Court box ${courtNumbers.join("/")}`,
        court_numbers: courtNumbers,
      });
      toast.push({ tone: "success", text: `Connected ${result.device.name}. The board will collect its key on its next announce.` });
      setSelected(null);
      setCode("");
      setDeviceCode("");
      setName("");
      setCourtNumbers([]);
      onClaimed();
      await refresh();
    } catch (e) {
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not connect that board."), durationMs: 8000 });
    } finally {
      setBusy(false);
    }
  }

  const claimable = boards.filter((b) => b.claimable);

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Radio className="h-5 w-5 text-slate-400" />
        <h2 className="text-lg font-semibold">Connect a board</h2>
      </div>

      {status && !status.listening && (
        <div className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {/* The listener not running is the single most likely reason nothing appears,
              and it is invisible from the cupboard. The hint comes from the server. */}
          <strong>Not listening for boards.</strong>{" "}
          {status.hint ?? status.detail ?? "Discovery is not running on this deployment."}
        </div>
      )}

      {claimable.length === 0 ? (
        <p className="text-sm text-slate-500">
          No unclaimed boards are announcing. Power the box on and give it a moment to join the WiFi —
          it announces every few seconds and this list refreshes on its own.
        </p>
      ) : (
        <div className="space-y-2">
          {claimable.map((board) => (
            <label
              key={board.mac}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg border p-3",
                selected === board.mac ? "border-indigo-400 bg-indigo-50" : "border-slate-200",
              )}
            >
              <input
                type="radio"
                name="board"
                aria-label={`Board ${board.mac}`}
                checked={selected === board.mac}
                onChange={() => setSelected(board.mac)}
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{board.mac}</div>
                <div className="text-xs text-slate-500">
                  {board.address} · {board.hardware} · firmware {board.firmware}
                  {board.mega_version ? ` · Mega ${board.mega_version}` : ""}
                </div>
              </div>
              <Badge tone="info">seen {relative(board.last_seen_at)}</Badge>
            </label>
          ))}
        </div>
      )}

      {selected && (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          <div>
            <Label htmlFor="claim-code">Code on the box's screen</Label>
            {/* The code is the whole security of claiming: it is generated on the board,
                shown only on its LCD, and never put on the network — what is broadcast is
                a commitment to it. Typing it is how an admin proves physical presence. */}
            <Input
              id="claim-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. K7RM4XPT"
              autoComplete="off"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="claim-name">Name</Label>
              <Input id="claim-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Court 1 box" />
            </div>
            <div>
              <Label htmlFor="claim-device-code">Device code</Label>
              <Input
                id="claim-device-code"
                value={deviceCode}
                onChange={(e) => setDeviceCode(e.target.value)}
                placeholder={suggestDeviceCode(courtNumbers)}
                autoComplete="off"
              />
            </div>
          </div>
          <div>
            <Label>Courts, by relay</Label>
            <p className="mb-2 text-xs text-slate-500">
              Relay A is the first output on the box. Assign the courts in the order they are wired.
            </p>
            <CourtListEditor value={courtNumbers} onChange={setCourtNumbers} courts={courts} disabled={busy} />
          </div>
          <Button onClick={() => void claim()} disabled={busy || code.trim().length === 0 || courtNumbers.length === 0}>
            {busy ? "Connecting…" : "Connect this board"}
          </Button>
        </div>
      )}

      <RegisterByHand courts={courts} onRegistered={onClaimed} />
    </Card>
  );
}

// --- register by hand ---------------------------------------------------------

/**
 * For a box that is not announcing — flashed on the bench, or on a network the API
 * cannot hear. The key comes back once and is shown until dismissed, because a toast
 * that fades after four seconds is not a way to hand somebody a secret.
 */
function RegisterByHand({ courts, onRegistered }: { courts: AdminCourt[]; onRegistered: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [deviceCode, setDeviceCode] = useState("");
  const [name, setName] = useState("");
  const [hardware, setHardware] = useState<DeviceHardware>("Esp8266");
  const [courtNumbers, setCourtNumbers] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ name: string; key: string; note: string } | null>(null);

  async function register() {
    setBusy(true);
    try {
      const result = await endpoints.adminDeviceRegister({
        deviceCode: deviceCode.trim() || suggestDeviceCode(courtNumbers),
        name: name.trim() || `Court box ${courtNumbers.join("/")}`,
        hardware,
        court_numbers: courtNumbers,
      });
      setIssued({ name: result.device.name, key: result.device_key, note: result.note });
      setDeviceCode("");
      setName("");
      setCourtNumbers([]);
      onRegistered();
    } catch (e) {
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not register that box."), durationMs: 8000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      {!open ? (
        <Button variant="ghost" className="h-9 px-3 text-xs" onClick={() => setOpen(true)}>
          <KeyRound className="mr-1 h-4 w-4" /> Register a box by hand
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Register a box by hand</h3>
            <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setOpen(false)}>Close</Button>
          </div>
          <p className="text-xs text-slate-500">
            For a box that is not announcing. You will get its key once — flash it into the board's secrets before leaving this page.
          </p>

          {issued && (
            <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
              <div className="font-medium">{issued.name} registered.</div>
              <code className="mt-1 block break-all font-mono text-xs" aria-label="Device key">{issued.key}</code>
              <div className="mt-1 text-xs">{issued.note}</div>
              <Button variant="ghost" className="mt-2 h-8 px-2 text-xs" onClick={() => setIssued(null)}>I've stored it</Button>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="register-device-code">Device code</Label>
              <Input
                id="register-device-code"
                value={deviceCode}
                onChange={(e) => setDeviceCode(e.target.value)}
                placeholder={suggestDeviceCode(courtNumbers)}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="register-name">Name</Label>
              <Input id="register-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Court 1 box" />
            </div>
            <div>
              <Label htmlFor="register-hardware">Hardware</Label>
              <select
                id="register-hardware"
                className="h-11 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm"
                value={hardware}
                onChange={(e) => setHardware(e.target.value as DeviceHardware)}
              >
                <option value="Esp8266">ESP8266 — court box</option>
                <option value="Mega2560">Mega 2560</option>
                <option value="Esp32">ESP32</option>
              </select>
            </div>
          </div>
          <div>
            <Label>Courts, by relay</Label>
            <CourtListEditor value={courtNumbers} onChange={setCourtNumbers} courts={courts} disabled={busy} labelPrefix="New box" />
          </div>
          <Button onClick={() => void register()} disabled={busy || courtNumbers.length === 0}>
            {busy ? "Registering…" : "Register box"}
          </Button>
        </div>
      )}
    </div>
  );
}

// --- one board in the list --------------------------------------------------

function DeviceRow({
  device, courts, onChannel, onCourts, onRevoke,
}: {
  device: AdminDevice;
  courts: AdminCourt[];
  onChannel: (channel: OtaChannel) => Promise<void>;
  onCourts: (courtNumbers: number[]) => Promise<boolean>;
  onRevoke: () => Promise<void>;
}) {
  const online = isOnline(device);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number[]>(device.court_numbers);
  const [saving, setSaving] = useState(false);

  async function saveCourts() {
    setSaving(true);
    try {
      if (await onCourts(draft)) setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {online
          ? <Wifi className="h-4 w-4 text-emerald-500" aria-label="online" />
          : <WifiOff className="h-4 w-4 text-slate-300" aria-label="offline" />}
        <span className="font-medium">{device.name}</span>
        <Badge tone={online ? "success" : "muted"}>
          {online ? "online" : `last seen ${relative(device.last_seen_at)}`}
        </Badge>
        {device.revoked_at && <Badge tone="danger">revoked</Badge>}
        {device.failed_version && (
          // A build this box installed and could never work on. Loud, because a fleet
          // quietly declining an update is the kind of silence noticed a week after the
          // release was promoted everywhere.
          <Badge tone="danger">firmware {device.failed_version} failed to start</Badge>
        )}
      </div>

      <div className="mt-1 text-xs text-slate-500">
        {device.device_code}
        {device.kind === "Gate"
          ? (device.gate_key ? ` · gate ${device.gate_key}` : "")
          : ` · ${describeCourts(device.court_numbers)}`}
        {device.mac_address ? ` · ${device.mac_address}` : ""}
        {device.last_ip_address ? ` · ${device.last_ip_address}` : ""}
        {device.running_version ? ` · firmware ${device.running_version}` : ""}
        {device.mega_version ? ` · Mega ${device.mega_version}` : ""}
      </div>

      {editing && (
        <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
          <CourtListEditor value={draft} onChange={setDraft} courts={courts} disabled={saving} labelPrefix={device.name} />
          <div className="flex gap-2">
            <Button className="h-8 px-3 text-xs" onClick={() => void saveCourts()} disabled={saving || draft.length === 0}>
              {saving ? "Saving…" : "Save courts"}
            </Button>
            <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => { setDraft(device.court_numbers); setEditing(false); }} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label={`${device.name} update channel`}
          className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-sm"
          value={device.ota_channel}
          onChange={(e) => void onChannel(e.target.value as OtaChannel)}
        >
          <option value="Stable">Stable</option>
          <option value="Canary">Canary — takes new firmware first</option>
          <option value="Pinned">Pinned — held at one version</option>
        </select>

        {device.kind !== "Gate" && !device.revoked_at && !editing && (
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={() => { setDraft(device.court_numbers); setEditing(true); }}>
            Edit courts
          </Button>
        )}

        <ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onRevoke} />
      </div>
    </div>
  );
}

// --- the page ---------------------------------------------------------------

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

  async function saveButtonMap() {
    if (!settings) return;
    setSavingMap(true);
    try {
      // Only the button map changes. Every other field is sent as it was read, and the
      // nine economics keys are omitted entirely — the API reads absent as unchanged,
      // so this screen cannot revert a change made on the settings screen.
      await endpoints.adminSettingsSave({ ...settings, button_map: buttonMap });
      toast.push({ tone: "success", text: "Button map saved. Boxes pick it up on their next heartbeat." });
    } catch (e) {
      // The server checks the map against every box's court list and names the one
      // that cannot honour it. That sentence is the whole point of the refusal.
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not save the button map."), durationMs: 8000 });
    } finally {
      setSavingMap(false);
    }
  }

  async function setChannel(device: AdminDevice, channel: OtaChannel) {
    try {
      await endpoints.adminDeviceUpdate(device.id, { otaChannel: channel });
      toast.push({ tone: "success", text: `${device.name} is now on the ${channel.toLowerCase()} channel.` });
      await load();
    } catch (e) {
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not change the update channel.") });
    }
  }

  /** Returns whether the save went through, so the row knows whether to leave edit mode. */
  async function assignCourts(device: AdminDevice, courtNumbers: number[]): Promise<boolean> {
    try {
      await endpoints.adminDeviceUpdate(device.id, { court_numbers: courtNumbers });
      toast.push({ tone: "success", text: `${device.name} now drives ${describeCourts(courtNumbers)}.` });
      await load();
      return true;
    } catch (e) {
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not change that box's courts."), durationMs: 8000 });
      return false;
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      <h1 className="text-2xl font-bold">Devices</h1>

      <ConnectBoard courts={courts} onClaimed={() => void load()} />

      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Cpu className="h-5 w-5 text-slate-400" />
          <h2 className="text-lg font-semibold">Connected boards</h2>
        </div>

        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="text-sm text-slate-500">No boards are connected yet.</p>
        ) : (
          <div className="space-y-3">
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                courts={courts}
                onChannel={(channel) => setChannel(device, channel)}
                onCourts={(courtNumbers) => assignCourts(device, courtNumbers)}
                onRevoke={async () => {
                  await endpoints.adminDeviceRevoke(device.id);
                  toast.push({ tone: "success", text: `${device.name} revoked. It can no longer authenticate.` });
                  await load();
                }}
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
          next heartbeat.
        </p>

        <ButtonMapEditor value={buttonMap} onChange={setButtonMap} disabled={savingMap || loading} />

        <div className="mt-4">
          <Button onClick={() => void saveButtonMap()} disabled={savingMap || loading}>
            {savingMap ? "Saving…" : "Save button map"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
