import { useEffect, useState, cloneElement, isValidElement, useId } from "react";
import { endpoints, type AdminSettings, type AdminCourt, ApiError } from "../lib/api";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { useToast } from "../components/Toast";

const minToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const hhmmToMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};

export default function AdminSettingsPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [courts, setCourts] = useState<AdminCourt[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([endpoints.adminSettingsGet(), endpoints.adminCourtsList()]);
      setSettings(s);
      setCourts(c);
    } catch {
      toast.push({ tone: "danger", text: "Couldn't load settings." });
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      // The whole settings object EXCEPT the button map, which the devices screen owns.
      // The API reads an absent key as unchanged, so leaving it out is what stops this
      // form reverting a remap somebody made there.
      const { button_map: _buttonMap, ...withoutButtonMap } = settings;
      await endpoints.adminSettingsSave(withoutButtonMap);
      toast.push({ tone: "success", text: "Settings saved." });
    } catch (err) {
      const msg = err instanceof ApiError && typeof err.payload === "object" && err.payload && "error" in (err.payload as Record<string, unknown>)
        ? String((err.payload as { error: string }).error)
        : "Save failed.";
      toast.push({ tone: "danger", text: msg.replace(/_/g, " ") });
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) return <p className="text-text-secondary">Loading settings…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Admin · Settings</h1>
        <p className="text-sm text-text-secondary">Court schedule, booking limits, and penalty policy for this tenant.</p>
      </div>

      <Card className="space-y-5">
        <h2 className="text-base font-semibold">Booking</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Reserve window (days ahead)" hint="0–365. Members can only book up to this many days in advance.">
            <Input type="number" min={0} max={365} value={settings.advance_booking_days}
              onChange={(e) => setSettings({ ...settings, advance_booking_days: Number(e.target.value) })} />
          </Field>
          <Field label="Slice length (minutes)" hint="Each booking is one or more slices, e.g. 30 min.">
            <Input type="number" min={5} max={240} step={5} value={settings.slice_minutes}
              onChange={(e) => setSettings({ ...settings, slice_minutes: Number(e.target.value) })} />
          </Field>
          <Field label="Day starts">
            <Input type="time" value={minToHHMM(settings.day_start_minute)}
              onChange={(e) => setSettings({ ...settings, day_start_minute: hhmmToMin(e.target.value) })} />
          </Field>
          <Field label="Day ends">
            <Input type="time" value={minToHHMM(settings.day_end_minute)}
              onChange={(e) => setSettings({ ...settings, day_end_minute: hhmmToMin(e.target.value) })} />
          </Field>
        </div>
      </Card>

      <Card className="space-y-5">
        <h2 className="text-base font-semibold">No-show & cancellation policy</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Penalty (% of slice price)">
            <Input type="number" min={0} max={100} value={settings.penalty_pct}
              onChange={(e) => setSettings({ ...settings, penalty_pct: Number(e.target.value) })} />
          </Field>
          <Field label="Grace window (minutes)" hint="After slot start, before a no-show triggers.">
            <Input type="number" min={0} max={60} value={settings.grace_window_minutes}
              onChange={(e) => setSettings({ ...settings, grace_window_minutes: Number(e.target.value) })} />
          </Field>
          <Field label="Late-cancel window (minutes)" hint="Cancellations within this many minutes of start incur the penalty.">
            <Input type="number" min={0} max={1440} value={settings.penalty_window_minutes}
              onChange={(e) => setSettings({ ...settings, penalty_window_minutes: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>

      <Card className="space-y-5">
        <h2 className="text-base font-semibold">Credits &amp; top-ups</h2>
        {/* These four decide what a member's money is worth. Until now the only way to
            change one was to hand-edit a JSON column on a live system — no validation,
            no audit trail, and a typo away from making every top-up worthless. */}
        <p className="text-sm text-text-secondary">
          Credits are the unit of account. A member pays in rand and receives credits at the rate for their class.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Credits per R1 — members" hint="R100 at 1.6 gives 160 credits.">
            <Input type="number" min={0.01} max={1000} step={0.1} value={settings.credits_per_zar_regular}
              onChange={(e) => setSettings({ ...settings, credits_per_zar_regular: Number(e.target.value) })} />
          </Field>
          <Field label="Credits per R1 — league / over-65" hint="R100 at 2.4 gives 240 credits.">
            <Input type="number" min={0.01} max={1000} step={0.1} value={settings.credits_per_zar_league}
              onChange={(e) => setSettings({ ...settings, credits_per_zar_league: Number(e.target.value) })} />
          </Field>
          <Field label="Top-up block (R)" hint="Members top up in multiples of this.">
            <Input type="number" min={1} max={100000} value={settings.topup_block_zar}
              onChange={(e) => setSettings({ ...settings, topup_block_zar: Number(e.target.value) })} />
          </Field>
          <Field label="Top-up cap per member (R)" hint="Must be at least one block, or no top-up is ever legal.">
            <Input type="number" min={1} max={100000} value={settings.topup_max_zar_per_member}
              onChange={(e) => setSettings({ ...settings, topup_max_zar_per_member: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>

      <Card className="space-y-5">
        <h2 className="text-base font-semibold">Court access</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Court time per member per day (minutes)" hint="0 turns the cap off. A slot starting today is allowed over the cap if the court is otherwise free.">
            <Input type="number" min={0} max={1440} step={15} value={settings.member_per_day_max_minutes}
              onChange={(e) => setSettings({ ...settings, member_per_day_max_minutes: Number(e.target.value) })} />
          </Field>
          <Field label="Peak hours" hint="Reserved for league and over-65 members. Format 16:00-19:00.">
            <Input type="text" value={settings.peak_hours}
              onChange={(e) => setSettings({ ...settings, peak_hours: e.target.value })} />
          </Field>
          <Field label="Peak opens to everyone (hours before start)" hint="An empty peak slot opens to all members this many hours before it begins.">
            <Input type="number" min={0} max={336} value={settings.peak_advance_hours_for_regular}
              onChange={(e) => setSettings({ ...settings, peak_advance_hours_for_regular: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>

      <Card className="space-y-5">
        <h2 className="text-base font-semibold">Records</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Keep usage history for (years)">
            <Input type="number" min={1} max={50} value={settings.retention_years}
              onChange={(e) => setSettings({ ...settings, retention_years: Number(e.target.value) })} />
          </Field>
          <Field label="No-show sweep looks back (days)" hint="Bounds how far back the sweep reaches, so switching it on cannot post a backlog of historical no-shows at once.">
            <Input type="number" min={1} max={365} value={settings.no_show_lookback_days}
              onChange={(e) => setSettings({ ...settings, no_show_lookback_days: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</Button>
        </div>
      </Card>

      <CourtsSection courts={courts} reload={load} />
    </div>
  );
}

/**
 * A labelled form field.
 *
 * The label used to be a bare `<Label>` with no `htmlFor`, which meant every input on
 * this page — conversion rates, penalty percentages, operating hours — was unlabelled
 * to a screen reader and unclickable by its caption. Cloning the child to attach a
 * generated id keeps the call sites as short as they were and makes the association
 * real; the hint is wired through `aria-describedby` for the same reason.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;

  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<{ id?: string; "aria-describedby"?: string }>, {
        id,
        ...(hint ? { "aria-describedby": hintId } : {}),
      })
    : children;

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {control}
      {hint && <p id={hintId} className="text-xs text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

function CourtsSection({ courts, reload }: { courts: AdminCourt[]; reload: () => Promise<void> }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState(50);

  const create = async () => {
    if (!newName.trim()) { toast.push({ tone: "warning", text: "Court name is required." }); return; }
    setAdding(true);
    try {
      await endpoints.adminCourtsCreate({ name: newName.trim(), slicePriceCredits: newPrice });
      setNewName(""); setNewPrice(50);
      await reload();
      toast.push({ tone: "success", text: "Court added." });
    } catch { toast.push({ tone: "danger", text: "Couldn't add court." }); }
    finally { setAdding(false); }
  };

  return (
    <Card className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Courts</h2>
        <span className="text-xs text-text-muted">{courts.filter((c) => c.is_active).length} active · {courts.length} total</span>
      </div>

      <div className="space-y-2">
        {courts.map((c) => <CourtRow key={c.id} court={c} reload={reload} />)}
        {courts.length === 0 && <p className="text-sm text-text-secondary">No courts yet — add one below.</p>}
      </div>

      <div className="border-t border-border pt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
        <Field label="New court name">
          <Input placeholder="Court 5" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </Field>
        <Field label="Price per slice (R)">
          <Input type="number" min={0} value={newPrice} onChange={(e) => setNewPrice(Number(e.target.value))} />
        </Field>
        <Button onClick={create} disabled={adding}>{adding ? "Adding…" : "Add court"}</Button>
      </div>
    </Card>
  );
}

function CourtRow({ court, reload }: { court: AdminCourt; reload: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState(court.name);
  const [price, setPrice] = useState(court.slice_price_credits);
  const [busy, setBusy] = useState(false);
  const dirty = name !== court.name || price !== court.slice_price_credits;

  const save = async () => {
    setBusy(true);
    try {
      await endpoints.adminCourtsUpdate(court.id, { name, slicePriceCredits: price });
      await reload();
      toast.push({ tone: "success", text: `${name} updated.` });
    } catch { toast.push({ tone: "danger", text: "Update failed." }); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await endpoints.adminCourtsDelete(court.id);
      await reload();
      toast.push({ tone: "success", text: `${court.name} deactivated.` });
    } catch { toast.push({ tone: "danger", text: "Deactivate failed." }); }
    finally { setBusy(false); }
  };

  return (
    <div className={`grid grid-cols-1 sm:grid-cols-[1fr_140px_auto_auto] gap-2 sm:items-center p-3 rounded-md border border-border ${court.is_active ? "bg-bg-surface" : "bg-bg-muted/40"}`}>
      <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!court.is_active} />
      <Input type="number" min={0} value={price} onChange={(e) => setPrice(Number(e.target.value))} disabled={!court.is_active} />
      <Button variant="outline" onClick={save} disabled={!dirty || busy || !court.is_active}>Save</Button>
      {court.is_active ? (
        <ConfirmButton
          idleLabel="Deactivate"
          confirmLabel="Confirm deactivate"
          onConfirm={remove}
          idleClassName="bg-danger-soft text-danger-strong hover:bg-danger-soft/70"
          className="h-11 px-4"
        />
      ) : (
        <span className="text-xs text-text-muted px-3">Inactive</span>
      )}
    </div>
  );
}
