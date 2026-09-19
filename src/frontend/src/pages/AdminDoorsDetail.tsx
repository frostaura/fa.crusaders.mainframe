import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Card } from "../components/Card";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { useToast } from "../components/Toast";
import { DoorAge } from "../components/doors/DoorAge";
import { DoorChips } from "../components/doors/DoorChips";
import { DoorFeed } from "../components/doors/DoorFeed";
import { DoorShutControl } from "../components/doors/DoorShutControl";
import { DoorSignalNotices } from "../components/doors/DoorSignalNotices";
import { DoorCardEditor, DoorCardRead } from "../components/doors/DoorCardFields";
import { GateDetailsEditor } from "../components/doors/GateDetailsEditor";
import { useTicker } from "../lib/useTicker";
import { isOnline, offlineAfterSecondsFor } from "../lib/deviceLiveness";
import { DOORS_READ_FAILED, doorStateNotice } from "../lib/doorsCopy";
import { UNNAMED_GATE, gateDeleteConfirm, unnamedGateOfflineNotice } from "../lib/gateCopy";
import { ACTIVITY_READ_FAILED } from "../lib/deviceActivity";
import { describeDeviceError } from "../lib/deviceErrors";
import {
  doorEndpoints, endpoints, type AdminSettings, type DeviceActivityEntry, type DoorRow,
  type DoorsView, type PowerLossBehaviour,
} from "../lib/api";

/**
 * One door — arrived at because something is wrong, or because a member complained about
 * last night.
 *
 * <p>
 * Read before write: the state and the feed are above the controls, and the door card sits
 * between them because the person reading it is often about to walk to the board.
 * </p>
 */

/** The club's own numbers, or nulls where the settings read failed. Never guessed. */
function signalSettingsOf(settings: AdminSettings | null) {
  return {
    spikeMinutes: settings?.door_refusal_spike_minutes ?? null,
    unlockSeconds: settings?.gate_unlock_seconds ?? null,
  };
}

function clubClock(iso: string | null, timezone: string): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone,
  });
}

export function AdminDoorsDetailPage() {
  const { id = "" } = useParams();
  const toast = useToast();
  const nav = useNavigate();
  const now = useTicker(true);
  const [view, setView] = useState<DoorsView | null>(null);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [entries, setEntries] = useState<DeviceActivityEntry[] | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedLoading, setFeedLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<"name" | "card" | null>(null);

  const readDoors = useCallback(async () => {
    setView(await doorEndpoints.doors());
    setFailed(false);
  }, []);

  const load = useCallback(async () => {
    try { await readDoors(); } catch { setFailed(true); setView(null); } finally { setLoading(false); }
    try { setSettings(await endpoints.adminSettingsGet()); } catch { /* signals simply do not render */ }
    try {
      setEntries((await endpoints.adminDeviceActivity(id)).items);
      setFeedError(null);
    } catch (e) {
      setFeedError(describeDeviceError(e, ACTIVITY_READ_FAILED));
      setEntries(null);
    } finally {
      setFeedLoading(false);
    }
  }, [id, readDoors]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">Loading this door…</p>;
  if (failed) {
    return (
      <div className="space-y-3">
        <BackToDoors />
        <Alert tone="danger">{DOORS_READ_FAILED}</Alert>
        <Button variant="outline" onClick={() => void load()}>Try again</Button>
      </div>
    );
  }

  const row: DoorRow | undefined = view?.doors.find((d) => d.device.id === id);
  if (!row) {
    return (
      <div className="space-y-3">
        <BackToDoors />
        <p className="text-sm text-text-secondary">
          That door is not on the club's list. It may have been deleted — a board re-registers itself
          on its next heartbeat, with no name.
        </p>
      </div>
    );
  }

  const door = row.device;
  const timezone = view!.timezone;
  const online = isOnline(door, offlineAfterSecondsFor(door, settings?.heartbeat_seconds ?? null), now);

  const saveName = async (name: string, gateKey: string) => {
    try {
      await endpoints.adminDeviceUpdate(door.id, { name, gate_key: gateKey });
      toast.push({
        tone: "success",
        // A cleared name is not a cosmetic loss: an unnamed door is sent an empty list, so it
        // stops working the moment it loses the network.
        text: gateKey === ""
          ? `${name} has no door name. ${unnamedGateOfflineNotice()}`
          : `${name} is the ${gateKey} door. It picks that up on its next heartbeat.`,
      });
      await readDoors();
      return true;
    } catch (e) {
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not save that door."), durationMs: 8000 });
      return false;
    }
  };

  const saveCard = async (note: string, behaviour: PowerLossBehaviour) => {
    try {
      await doorEndpoints.doorFieldsSave(door.id, { location_note: note, power_loss_behaviour: behaviour });
      toast.push({ tone: "success", text: `${door.name}'s door card saved.` });
      await readDoors();
      return true;
    } catch (e) {
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not save that door card."), durationMs: 8000 });
      return false;
    }
  };

  const setEnabled = async (enabled: boolean) => {
    try {
      await endpoints.adminDeviceUpdate(door.id, { enabled });
      toast.push({
        tone: "success",
        text: enabled
          ? `${door.name} is open again. A door that can reach the club opens for members from its very next scan.`
          : `${door.name} is shut. ${doorStateNotice({ ...door, enabled: false }, online, timezone)}`,
        durationMs: 8000,
      });
      await readDoors();
    } catch (e) {
      toast.push({
        tone: "danger",
        text: describeDeviceError(e, enabled ? "Could not reopen that door." : "Could not shut that door."),
        durationMs: 8000,
      });
    }
  };

  const remove = async () => {
    try {
      await endpoints.adminDeviceDelete(door.id);
      toast.push({
        tone: "success",
        text: `${door.name} deleted. It still has the club's key, so it re-registers on its next heartbeat as a new door with no name — unplug it if you meant to retire it.`,
        durationMs: 8000,
      });
      nav("/admin/doors");
    } catch (e) {
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not delete that door.") });
    }
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <BackToDoors />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-bold tracking-tight">{door.name}</h1>
          <DoorChips device={door} online={online} />
          <span className="sm:ml-auto"><DoorAge at={door.last_seen_at} now={now} prefix={online ? "Heard from" : "Last heard from"} /></span>
        </div>
        <p className="min-w-0 break-words text-xs text-text-muted">
          {`${door.gate_key ?? UNNAMED_GATE} · ${door.device_code}`}
        </p>
      </header>

      <Card><p className="text-sm text-text-secondary">{doorStateNotice(door, online, timezone)}</p></Card>

      <DoorSignalNotices doorName={door.name} signals={row.signals} settings={signalSettingsOf(settings)} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <DoorFeed
          door={door}
          entries={entries}
          loading={feedLoading}
          error={feedError}
          now={now}
          dayStartedAt={view!.day_started_at}
          timezone={timezone}
        />

        <div className="space-y-6">
          <section aria-labelledby="door-card-heading" className="space-y-2">
            <h2 id="door-card-heading" className="text-lg font-semibold">Door card</h2>
            <Card className="space-y-4">
              {editing === "card" ? (
                <DoorCardEditor door={door} onSave={saveCard} onClose={() => setEditing(null)} />
              ) : (
                <>
                  <DoorCardRead door={door} />
                  <dl className="space-y-1 text-sm">
                    <Fact label="Board" value={door.device_code} />
                    <Fact label="MAC" value={door.mac_address ?? "not reported"} />
                    <Fact label="Firmware" value={door.running_version ?? "not reported"} />
                    <Fact label="Door name" value={door.gate_key ?? UNNAMED_GATE} />
                  </dl>
                  <ClubContact settings={settings} />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => setEditing("card")}>Edit</Button>
                    <Link
                      to={`/admin/doors/${door.id}/card`}
                      className="inline-flex min-h-11 items-center rounded-lg border border-control px-5 text-sm font-medium"
                    >
                      Print this door card
                    </Link>
                  </div>
                </>
              )}
            </Card>
          </section>

          <Card className="space-y-3">
            {editing === "name" ? (
              <GateDetailsEditor device={door} onSave={saveName} onClose={() => setEditing(null)} />
            ) : (
              <Button variant="outline" className="w-full" onClick={() => setEditing("name")}>
                Edit name and door name
              </Button>
            )}
            <DoorShutControl door={door} onDone={setEnabled} shutAt={clubClock(door.out_of_service_since ?? null, timezone)} />
            <ConfirmButton
              idleLabel="Delete"
              confirmLabel={gateDeleteConfirm()}
              ariaLabel={`Delete ${door.name}`}
              onConfirm={remove}
              tone="danger"
              className="h-11 w-full"
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

function BackToDoors() {
  return <Link to="/admin/doors" className="inline-flex min-h-11 items-center text-sm text-accent-strong">← Doors</Link>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <dt className="w-24 shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

/**
 * Both halves of the club contact.
 *
 * A door card with a blank where the phone number goes is a card that says nothing; a card
 * that says nobody has set one, and where to set it, is a job. It is what a member sees when
 * a door turns them away, which is why it belongs on the card at all.
 */
function ClubContact({ settings }: { settings: AdminSettings | null }) {
  const phone = settings?.club_contact_phone?.trim();
  const email = settings?.club_contact_email?.trim();
  const parts = [phone, email].filter((part) => part);
  if (parts.length > 0) {
    return <p className="text-sm"><span className="text-text-muted">Club contact</span> {parts.join(" · ")}</p>;
  }
  return (
    <p className="text-sm text-text-secondary">
      No club contact is set. Add one under{" "}
      <Link to="/admin/settings" className="text-accent-strong underline">Admin settings</Link>
      {" "}— it is what a member sees when a door turns them away.
    </p>
  );
}
