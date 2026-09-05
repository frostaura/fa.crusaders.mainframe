import { useCallback, useEffect, useRef, useState } from "react";
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
import { ButtonMapEditor, buttonMapWithinCap, RELAYS } from "../components/ButtonMapEditor";
import { IssuedKeyPanel, type IssuedKey } from "../components/IssuedKeyPanel";
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
 *
 * Every device key this screen is ever handed — on claim, on manual registration, on
 * rotation — is shown once in a panel that stays until dismissed, and is held in
 * component state only. It is never written to storage.
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
 * Missed beats before a box is called offline.
 *
 * <p>
 * Three, so one slow request or one dropped datagram is not an outage. It used to be
 * three beats of an assumed 30-second cadence, frozen as a literal 180 000 ms — and the
 * settings page then grew an editable interval offering up to 3600 s, at which point a
 * club that raised it to reduce chatter watched the whole fleet read offline for most
 * of every interval and started power-cycling boxes mid-league-night (review finding 22).
 * The threshold is derived from the cadence now, and the cadence from what the box runs.
 * </p>
 */
const MISSED_BEATS_BEFORE_OFFLINE = 3;

/**
 * The interval this box is really calling in on: what the API says it runs, else the
 * tenant setting put through the same clamp the firmware applies.
 */
function effectiveHeartbeatSeconds(device: AdminDevice, tenantSeconds: number | null): number {
  const declared = device.heartbeat_seconds ?? tenantSeconds ?? HEARTBEAT_FALLBACK_S;
  return Math.min(Math.max(declared, HEARTBEAT_MIN_S), HEARTBEAT_MAX_S);
}

function isOnline(device: AdminDevice, heartbeatSeconds: number) {
  if (!device.last_seen_at) return false;
  return Date.now() - new Date(device.last_seen_at).getTime() < heartbeatSeconds * MISSED_BEATS_BEFORE_OFFLINE * 1000;
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
  // The API checks every court number against the courts table on register, update and
  // claim (DeviceRegistryService.CourtNumberNotFound). The pickers here only offer real
  // courts, so this mostly means a court was deleted while the form was open.
  court_number_not_found: "One of those court numbers is not a court at this club. Refresh the page and pick the court again — if it is missing, add it under Admin settings.",
  device_code_taken: "That device code is already in use. Pick another.",
  // ButtonMap.TryParse refused the map itself — an unknown token, or a grant past the
  // relay's hard cap. The editor bounds the field, so this is a map that arrived from
  // somewhere else, or a hand-edited one.
  button_map_invalid: "One of the buttons is set to something a box cannot do. Court is A–D and a grant is 1–90 minutes.",
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

// --- connect a board --------------------------------------------------------

/**
 * What a revoked box's row hands the claim form: the board to pick and the details
 * it had, so re-claiming is "type the code on the LCD" and nothing else.
 */
type ClaimPrefill = { mac: string; name: string; deviceCode: string; courtNumbers: number[] };

function ConnectBoard({ courts, onClaimed, prefill }: { courts: AdminCourt[]; onClaimed: () => void; prefill: ClaimPrefill | null }) {
  const toast = useToast();
  const [boards, setBoards] = useState<DiscoveredBoard[]>([]);
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const [name, setName] = useState("");
  const [courtNumbers, setCourtNumbers] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedKey | null>(null);

  // A re-claim from a revoked row arrives as a prefill. Applied during render, the
  // React-documented way to adopt a prop into state, so the form is filled on the
  // same pass rather than a frame later.
  const [applied, setApplied] = useState<ClaimPrefill | null>(null);
  if (prefill && prefill !== applied) {
    setApplied(prefill);
    setSelected(prefill.mac);
    setName(prefill.name);
    setDeviceCode(prefill.deviceCode);
    setCourtNumbers(prefill.courtNumbers);
  }

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
      // The key used to be dropped here in favour of a toast. It is the one thing an
      // admin can act on if the board misses its ten-minute grant.
      //
      // `reclaimed` says whether this was a first claim or a MAC the club already had a
      // row for — re-keyed, un-revoked, same id — and the admin is told which, because
      // "connected" on a box they thought was gone reads as a duplicate until they know
      // it is the same row.
      const reclaimed = result.reclaimed === true;
      setIssued({
        name: result.device.name,
        key: result.device_key,
        keyVersion: result.key_version,
        via: reclaimed ? "reclaim" : "claim",
        note: result.note || undefined,
      });
      toast.push({
        tone: "success",
        text: reclaimed
          ? `Re-keyed ${result.device.name} — it was already registered here, so its row was re-enabled with a new key (version ${result.key_version}) rather than added twice. The board collects it on its next announce.`
          : `Connected ${result.device.name}. The board will collect its key on its next announce.`,
        durationMs: reclaimed ? 8000 : undefined,
      });
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
  const selectedIsAnnouncing = selected !== null && claimable.some((b) => b.mac === selected);

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Radio className="h-5 w-5 text-slate-400" />
        <h2 className="text-lg font-semibold">Connect a board</h2>
      </div>

      {issued && <div className="mb-3"><IssuedKeyPanel issued={issued} onDismiss={() => setIssued(null)} /></div>}

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
          {!selectedIsAnnouncing && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              {/* A re-claimed box only announces a claim code once it has lost its old
                  key — which it does after a few refused calls, or a power cycle. */}
              Board {selected} is not announcing a claim code yet. Power-cycle it; once its screen
              shows CLAIM CODE it appears in the list above and the code can be typed here.
            </p>
          )}
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
  const [issued, setIssued] = useState<IssuedKey | null>(null);

  async function register() {
    setBusy(true);
    try {
      const result = await endpoints.adminDeviceRegister({
        deviceCode: deviceCode.trim() || suggestDeviceCode(courtNumbers),
        name: name.trim() || `Court box ${courtNumbers.join("/")}`,
        hardware,
        court_numbers: courtNumbers,
      });
      setIssued({ name: result.device.name, key: result.device_key, keyVersion: result.key_version, via: "register" });
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

          {issued && <IssuedKeyPanel issued={issued} onDismiss={() => setIssued(null)} />}

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

// --- one board's own button map ------------------------------------------------

/**
 * A box's own button map, or the club's.
 *
 * Rendered only when the device payload carries `button_map` — the field is landing on
 * the API alongside this screen, and an older API that does not send it must not show
 * an editor whose save would bind to nothing. Null means "the club's map".
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
  channel: (channel: OtaChannel) => Promise<void>;
  courts: (courtNumbers: number[]) => Promise<boolean>;
  buttonMap: (map: string[] | null) => Promise<boolean>;
  revoke: () => Promise<void>;
  rotate: () => Promise<void>;
  reclaim: () => void;
};

function DeviceRow({
  device, courts, clubMap, actions, heartbeatSeconds,
}: {
  device: AdminDevice;
  courts: AdminCourt[];
  clubMap: string[];
  actions: DeviceActions;
  /** The cadence this box actually runs. See effectiveHeartbeatSeconds. */
  heartbeatSeconds: number;
}) {
  const online = isOnline(device, heartbeatSeconds);
  const [editing, setEditing] = useState<"courts" | "buttons" | null>(null);
  const [draft, setDraft] = useState<number[]>(device.court_numbers);
  const [saving, setSaving] = useState(false);
  const revoked = device.revoked_at !== null;
  const isBox = device.kind !== "Gate";
  // Presence-gated: an API that does not send the field gets no editor for it.
  const hasOwnMapField = device.button_map !== undefined;

  async function saveCourts() {
    setSaving(true);
    try {
      if (await actions.courts(draft)) setEditing(null);
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
        {revoked && <Badge tone="danger">revoked — refused until re-claimed</Badge>}
        {revoked && !device.mac_address && <Badge tone="warning">no board address</Badge>}
        {hasOwnMapField && device.button_map != null && <Badge tone="info">own button map</Badge>}
        {device.failed_version && (
          // A build this box installed and could never work on. Loud, because a fleet
          // quietly declining an update is the kind of silence noticed a week after the
          // release was promoted everywhere.
          <Badge tone="danger">firmware {device.failed_version} failed to start</Badge>
        )}
      </div>

      <div className="mt-1 text-xs text-slate-500">
        {device.device_code}
        {isBox ? ` · ${describeCourts(device.court_numbers)}` : (device.gate_key ? ` · gate ${device.gate_key}` : "")}
        {device.mac_address ? ` · ${device.mac_address}` : ""}
        {device.last_ip_address ? ` · ${device.last_ip_address}` : ""}
        {device.running_version ? ` · firmware ${device.running_version}` : ""}
        {device.mega_version ? ` · Mega ${device.mega_version}` : ""}
        {` · key v${device.key_version}`}
      </div>

      {revoked && !device.mac_address && (
        // Re-claiming matches a board by the MAC it announces against the MAC on the
        // row, and a box registered by hand has never announced, so its row carries
        // none. Nothing on this screen can clear `revoked_at` for it — rotating a key
        // does not, and updating a device does not. Saying so is worth more than the
        // old advice to "register it again by hand", which returns device_code_taken
        // and leaves the row exactly as revoked as it was.
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
          This box was registered by hand, so the club has no board address for it — and re-claiming matches boards by
          address. Power the box on so it announces, then connect it under "Connect a board" above with a different
          device code; that gives the club a working row with an address. This one stays revoked and can be left as
          history.
        </p>
      )}

      {editing === "courts" && (
        <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
          <CourtListEditor value={draft} onChange={setDraft} courts={courts} disabled={saving} labelPrefix={device.name} />
          <div className="flex gap-2">
            <Button className="h-8 px-3 text-xs" onClick={() => void saveCourts()} disabled={saving || draft.length === 0}>
              {saving ? "Saving…" : "Save courts"}
            </Button>
            <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => { setDraft(device.court_numbers); setEditing(null); }} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {editing === "buttons" && (
        <DeviceButtonMapPanel device={device} clubMap={clubMap} onSave={actions.buttonMap} onClose={() => setEditing(null)} />
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label={`${device.name} update channel`}
          className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-sm"
          value={device.ota_channel}
          onChange={(e) => void actions.channel(e.target.value as OtaChannel)}
        >
          <option value="Stable">Stable</option>
          <option value="Canary">Canary — takes new firmware first</option>
          <option value="Pinned">Pinned — held at one version</option>
        </select>

        {isBox && !revoked && editing === null && (
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={() => { setDraft(device.court_numbers); setEditing("courts"); }}>
            Edit courts
          </Button>
        )}

        {isBox && !revoked && hasOwnMapField && editing === null && (
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={() => setEditing("buttons")}>
            Edit buttons
          </Button>
        )}

        {revoked ? (
          // The backend accepts a claim against a revoked MAC and issues a new key. The
          // row hands its details to the claim form so the admin only types the code.
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={actions.reclaim}>
            Re-claim
          </Button>
        ) : (
          <>
            <ConfirmButton
              idleLabel="Rotate key"
              confirmLabel="Refuse it until it has the new key?"
              onConfirm={actions.rotate}
              className="h-8 px-3"
            />
            {/* What revoking does, in the confirm label: the box stops being accepted
                until it is re-claimed. "Really revoke?" told nobody that. */}
            <ConfirmButton
              idleLabel="Revoke"
              confirmLabel="Refuse this box until re-claimed?"
              onConfirm={actions.revoke}
              idleClassName="bg-danger-soft text-danger-strong hover:bg-danger-soft/70"
              className="h-8 px-3"
            />
          </>
        )}
      </div>
    </div>
  );
}

// --- the page ---------------------------------------------------------------

/**
 * The mutations a row can ask for, built per device. Kept out of the page component
 * so the page stays a loader and a layout.
 */
function useDeviceActions(reload: () => Promise<void>, onKeyIssued: (key: IssuedKey) => void, onReclaim: (prefill: ClaimPrefill) => void) {
  const toast = useToast();

  return (device: AdminDevice): DeviceActions => ({
    channel: async (channel) => {
      try {
        await endpoints.adminDeviceUpdate(device.id, { otaChannel: channel });
        toast.push({ tone: "success", text: `${device.name} is now on the ${channel.toLowerCase()} channel.` });
        await reload();
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not change the update channel.") });
      }
    },
    /** Returns whether the save went through, so the row knows whether to leave edit mode. */
    courts: async (courtNumbers) => {
      try {
        await endpoints.adminDeviceUpdate(device.id, { court_numbers: courtNumbers });
        toast.push({ tone: "success", text: `${device.name} now drives ${describeCourts(courtNumbers)}.` });
        await reload();
        return true;
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not change that box's courts."), durationMs: 8000 });
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
    revoke: async () => {
      try {
        await endpoints.adminDeviceRevoke(device.id);
        toast.push({
          tone: "success",
          text: `${device.name} revoked. It is refused until you re-claim it — power-cycle the box and it shows a new claim code.`,
          durationMs: 8000,
        });
        await reload();
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not revoke that box.") });
      }
    },
    rotate: async () => {
      try {
        const result = await endpoints.adminDeviceRotateKey(device.id);
        // The API's note is the delivery story — the key cannot be pushed to the board,
        // so it 401s, shows CLAIM CODE, and is connected again from the discovered list.
        // Shown verbatim in the panel, next to the key it is about.
        onKeyIssued({ name: device.name, key: result.device_key, keyVersion: result.key_version, via: "rotate", note: result.note || undefined });
        await reload();
      } catch (e) {
        toast.push({ tone: "danger", text: describeDeviceError(e, "Could not rotate that box's key.") });
      }
    },
    reclaim: () => {
      if (!device.mac_address) {
        // Registered by hand, so discovery has never heard it and the row has no MAC to
        // match a claim against. The old advice here — register it again by hand — is
        // refused with device_code_taken and would leave the row revoked either way.
        toast.push({
          tone: "warning",
          text: `${device.name} has no board address, so it cannot be re-claimed. Power it on so it announces, then connect it under "Connect a board" with a different device code.`,
          durationMs: 10000,
        });
        return;
      }
      onReclaim({ mac: device.mac_address, name: device.name, deviceCode: device.device_code, courtNumbers: device.court_numbers });
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
  const [prefill, setPrefill] = useState<ClaimPrefill | null>(null);
  const [rotated, setRotated] = useState<IssuedKey | null>(null);
  const connectRef = useRef<HTMLDivElement>(null);

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

  const actionsFor = useDeviceActions(load, setRotated, (next) => {
    setPrefill(next);
    // jsdom has no scrollIntoView; a browser does.
    connectRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  });

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

      <div ref={connectRef}>
        <ConnectBoard courts={courts} onClaimed={() => void load()} prefill={prefill} />
      </div>

      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Cpu className="h-5 w-5 text-slate-400" />
          <h2 className="text-lg font-semibold">Connected boards</h2>
        </div>

        {rotated && <div className="mb-3"><IssuedKeyPanel issued={rotated} onDismiss={() => setRotated(null)} /></div>}

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
                clubMap={buttonMap}
                actions={actionsFor(device)}
                heartbeatSeconds={effectiveHeartbeatSeconds(device, settings?.heartbeat_seconds ?? null)}
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
