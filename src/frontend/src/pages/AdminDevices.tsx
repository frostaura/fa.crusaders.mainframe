import { useCallback, useEffect, useMemo, useState } from "react";
import { Cpu, Radio, RefreshCw, Wifi, WifiOff } from "lucide-react";
import {
  endpoints,
  type AdminDevice,
  type AdminSettings,
  type DiscoveredBoard,
  type DiscoveryStatus,
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
 */

/** A device that has not called in for this long is shown as offline. Mirrors
 *  DeviceEndpoints.OfflineAfterSeconds on the server; a box heartbeats every 30s,
 *  so three missed beats is a real absence rather than one slow request. */
const OFFLINE_AFTER_MS = 180_000;

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
                {["A", "B", "C", "D"].map((c) => <option key={c} value={c}>Court {c}</option>)}
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

function ConnectBoard({ onClaimed }: { onClaimed: () => void }) {
  const toast = useToast();
  const [boards, setBoards] = useState<DiscoveredBoard[]>([]);
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [courtNumber, setCourtNumber] = useState("");
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
      const result = await endpoints.adminDeviceClaim({
        mac: selected,
        claimCode: code.trim().toUpperCase(),
        name: name.trim() || `Court box ${courtNumber || "?"}`,
        courtNumber: courtNumber === "" ? null : Number(courtNumber),
      });
      toast.push({ tone: "success", text: `Connected ${result.device.name}. The board will collect its key on its next announce.` });
      setSelected(null);
      setCode("");
      setName("");
      setCourtNumber("");
      onClaimed();
      await refresh();
    } catch (e) {
      toast.push({ tone: "danger", text: e instanceof Error ? e.message : "Could not connect that board." });
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
              <Label htmlFor="claim-court">Court number</Label>
              <Input id="claim-court" type="number" min={1} value={courtNumber} onChange={(e) => setCourtNumber(e.target.value)} />
            </div>
          </div>
          <Button onClick={() => void claim()} disabled={busy || code.trim().length === 0}>
            {busy ? "Connecting…" : "Connect this board"}
          </Button>
        </div>
      )}
    </Card>
  );
}

// --- the page ---------------------------------------------------------------

export function AdminDevicesPage() {
  const toast = useToast();
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [buttonMap, setButtonMap] = useState<string[]>([]);
  const [savingMap, setSavingMap] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [list, config] = await Promise.all([endpoints.adminDevicesList(), endpoints.adminSettingsGet()]);
    setDevices(list);
    setSettings(config);
    setButtonMap(config.button_map);
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
      toast.push({ tone: "danger", text: e instanceof Error ? e.message : "Could not save the button map." });
    } finally {
      setSavingMap(false);
    }
  }

  async function setChannel(device: AdminDevice, channel: string) {
    await endpoints.adminDeviceUpdate(device.id, { otaChannel: channel });
    toast.push({ tone: "success", text: `${device.name} is now on the ${channel.toLowerCase()} channel.` });
    await load();
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      <h1 className="text-2xl font-bold">Devices</h1>

      <ConnectBoard onClaimed={() => void load()} />

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
              <div key={device.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {isOnline(device)
                    ? <Wifi className="h-4 w-4 text-emerald-500" aria-label="online" />
                    : <WifiOff className="h-4 w-4 text-slate-300" aria-label="offline" />}
                  <span className="font-medium">{device.name}</span>
                  <Badge tone={isOnline(device) ? "success" : "muted"}>
                    {isOnline(device) ? "online" : `last seen ${relative(device.last_seen_at)}`}
                  </Badge>
                  {device.revoked_at && <Badge tone="danger">revoked</Badge>}
                  {device.failed_version && (
                    // A build this box installed and could never work on. Loud, because a
                    // fleet quietly declining an update is the kind of silence noticed a
                    // week after the release was promoted everywhere.
                    <Badge tone="danger">firmware {device.failed_version} failed to start</Badge>
                  )}
                </div>

                <div className="mt-1 text-xs text-slate-500">
                  {device.device_code}
                  {device.court_number !== null ? ` · court ${device.court_number}` : ""}
                  {device.mac_address ? ` · ${device.mac_address}` : ""}
                  {device.last_ip_address ? ` · ${device.last_ip_address}` : ""}
                  {device.running_version ? ` · firmware ${device.running_version}` : ""}
                  {device.mega_version ? ` · Mega ${device.mega_version}` : ""}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    aria-label={`${device.name} update channel`}
                    className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-sm"
                    value={device.ota_channel}
                    onChange={(e) => void setChannel(device, e.target.value)}
                  >
                    <option value="Stable">Stable</option>
                    <option value="Canary">Canary — takes new firmware first</option>
                    <option value="Pinned">Pinned — held at one version</option>
                  </select>

                  <ConfirmButton
                    idleLabel="Revoke"
                    confirmLabel="Really revoke?"
                    onConfirm={async () => {
                      await endpoints.adminDeviceRevoke(device.id);
                      toast.push({ tone: "success", text: `${device.name} revoked. It can no longer authenticate.` });
                      await load();
                    }}
                  />
                </div>
              </div>
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
          Boxes pick up a change on their next heartbeat.
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
