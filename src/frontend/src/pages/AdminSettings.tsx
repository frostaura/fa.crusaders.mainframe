import { useEffect, useState, cloneElement, isValidElement, useId } from "react";
import { endpoints, GATE_ACCESS_POLICIES, type AdminSettings, type AdminCourt, type GateAccessPolicy } from "../lib/api";
import {
  DAY_KEYS, DAY_NAMES, DEVICE_ALERT_COOLDOWN_MAX_MINUTES, DEVICE_ALERT_COOLDOWN_MIN_MINUTES,
  GATE_EARLY_ENTRY_MAX_MINUTES, GATE_EARLY_ENTRY_MIN_MINUTES,
  GATE_UNLOCK_MAX_SECONDS, GATE_UNLOCK_MIN_SECONDS, OFFLINE_FLOOR_SECONDS, describeOfflineAfter,
  deviceNumbersComplaint, doorBookingHorizonMinutes, formatDayHours, gateSettingsComplaint,
  operatingHoursComplaint, parseDayHours, timezoneOptions,
  type DayHours, type DayKey,
} from "../lib/tenantSettings";
import {
  GATE_POLICY_LABELS, describeCourtSettingDoorReach, describeDoorBookingHorizon, describeEarlyEntry,
  describeGatePolicy, gateOfflineFallbackNotice,
} from "../lib/gateCopy";
import { describeDeviceError } from "../lib/deviceErrors";
import { Card } from "../components/Card";
import { Button, Input, Label, fieldClassName } from "../components/Button";
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
      // Through the shared device-error dictionary rather than this screen's old
      // underscores-to-spaces swap. That swap is still the fallback for every token nobody
      // has written copy for — `topup_max_below_block` still reads as it did — but a code
      // that HAS a sentence now gets it, which is the difference between an admin reading
      // "gate unlock seconds out of range" and being told the bound is 1 to 30.
      toast.push({ tone: "danger", text: describeDeviceError(err, "Save failed."), durationMs: 8000 });
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) return <p className="text-text-secondary">Loading settings…</p>;

  // A weekly table with a bad row must not reach the API: the refusal names the day, but a
  // toast that has faded says nothing about which of seven rows to fix, and the row itself
  // is already saying it in red.
  const hoursComplaint = operatingHoursComplaint(settings.operating_hours ?? {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Admin · Settings</h1>
        <p className="text-sm text-text-secondary">Court schedule, booking limits, penalty policy and court-box behaviour for this tenant.</p>
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
          {/* The zone every wall-clock time on this page and every slot on the booking
              grid is read in. It was served by the API and had nowhere to be set: a club
              outside South Africa saw its whole schedule in Johannesburg time with no
              correction short of an UPDATE on a JSON column. */}
          <Field
            label="Timezone"
            hint="The zone the club's day is read in. Day start and end, the booking grid and every time a member sees are all in this zone."
          >
            <select
              value={settings.timezone}
              onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
              className={fieldClassName}
            >
              {timezoneOptions(settings.timezone).map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      <OperatingHoursSection settings={settings} onChange={setSettings} />

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
          {/* step 0.01, not 0.1.
              A number input's valid values step from `min`, not from zero, so min=0.01 with
              step=0.1 made the valid set 0.01, 0.11, … 1.51, 1.61 — and the club's own shipped
              rates, 1.6 and 2.4, were both stepMismatch. Every round rate an admin would type
              (1.5, 2.0, 2.5) was invalid, the arrows turned 1.6 into 1.61, and because Save is
              not a native submit nothing ever said so: the field looked fine while the arrows
              quietly moved the money conversion rate by a hundredth. Cents are the smallest unit
              anyone would express a rand rate in, so 0.01 is both the granularity and the base. */}
          <Field label="Credits per R1 — members" hint="R100 at 1.6 gives 160 credits.">
            <Input type="number" min={0.01} max={1000} step={0.01} value={settings.credits_per_zar_regular}
              onChange={(e) => setSettings({ ...settings, credits_per_zar_regular: Number(e.target.value) })} />
          </Field>
          <Field label="Credits per R1 — league / over-65" hint="R100 at 2.4 gives 240 credits.">
            <Input type="number" min={0.01} max={1000} step={0.01} value={settings.credits_per_zar_league}
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

      <DeviceNumbersSection settings={settings} onChange={setSettings} />

      <GateSection settings={settings} onChange={setSettings} />

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
          {/* Held on the gate block too, for the same reason it is held on the weekly
              table: a number input's min/max stop the spinner and nothing else, so a typed
              or pasted value would round-trip into a refusal the admin has to decode. */}
          <Button onClick={save} disabled={saving || hoursComplaint !== null || gateSettingsComplaint(settings) !== null || deviceNumbersComplaint(settings) !== null}>{saving ? "Saving…" : "Save settings"}</Button>
        </div>
      </Card>

      <CourtsSection courts={courts} reload={load} />
    </div>
  );
}

/**
 * The club's opening hours, per weekday.
 *
 * <p>
 * The engine has read <code>operating_hours</code> since it existed and this screen could
 * not write it. All the screen had was the flat "Day starts / Day ends" pair, which is only
 * the default for a weekday the map does not name — and the seed names all seven, so the
 * pair governed nothing. A club that changed it got <code>200 {"saved":true}</code>, a
 * "Settings saved." toast, and a Saturday that still ran 07:00–20:00 because that is what
 * the map said. The one setting the product enforces was the one setting it could not edit.
 * </p>
 *
 * <p>
 * A day is either on the club default or has hours of its own; there is no "closed all day",
 * because the engine has no way to express one — a range whose close is at or before its
 * open is refused as the typo it almost always is, on both sides of the wire.
 * </p>
 */
function OperatingHoursSection({ settings, onChange }: { settings: AdminSettings; onChange: (next: AdminSettings) => void }) {
  const map = settings.operating_hours ?? {};
  const complaint = operatingHoursComplaint(map);

  const setDay = (day: DayKey, hours: DayHours | null) => {
    const next = { ...map };
    if (hours === null) delete next[day];
    else next[day] = formatDayHours(hours);
    onChange({ ...settings, operating_hours: next });
  };

  return (
    <Card className="space-y-5">
      <h2 className="text-base font-semibold">Opening hours</h2>
      <p className="text-sm text-text-secondary">
        When members can book. A day left on the club default uses <strong className="text-text-primary">Day starts</strong> and{" "}
        <strong className="text-text-primary">Day ends</strong> above ({minToHHMM(settings.day_start_minute)}–{minToHHMM(settings.day_end_minute)}).
        These are the hours the booking grid draws and the API enforces — a slot outside them is refused, and a walk-up at the box is cut short at closing.
      </p>
      <div className="space-y-2">
        {DAY_KEYS.map((day) => (
          <DayHoursRow
            key={day}
            day={day}
            hours={parseDayHours(map[day])}
            fallback={{ open: minToHHMM(settings.day_start_minute), close: minToHHMM(settings.day_end_minute) }}
            error={complaint?.day === day ? complaint.message : null}
            onChange={(next) => setDay(day, next)}
          />
        ))}
      </div>
    </Card>
  );
}

/** One weekday: the club default, or a pair of times of its own. */
function DayHoursRow({ day, hours, fallback, error, onChange }: {
  day: DayKey;
  hours: DayHours | null;
  fallback: DayHours;
  error: string | null;
  onChange: (next: DayHours | null) => void;
}) {
  const name = DAY_NAMES[day];
  const custom = hours !== null;
  const shown = hours ?? fallback;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[120px_auto_1fr] gap-2 sm:items-center p-3 rounded-md border border-border">
      <span className="text-sm font-medium text-text-primary">{name}</span>
      <label className="flex items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={custom}
          aria-label={`${name} has its own hours`}
          // Ticking a day starts it at the club default rather than at 00:00, so the
          // first thing an admin sees is the hours that are actually in force for it.
          onChange={(e) => onChange(e.target.checked ? shown : null)}
        />
        Own hours
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {custom ? (
          <>
            <Input
              type="time"
              className="h-9 w-32"
              aria-label={`${name} opens`}
              value={shown.open}
              onChange={(e) => onChange({ ...shown, open: e.target.value })}
            />
            <span className="text-xs text-text-muted">to</span>
            <Input
              type="time"
              className="h-9 w-32"
              aria-label={`${name} closes`}
              value={shown.close}
              onChange={(e) => onChange({ ...shown, close: e.target.value })}
            />
          </>
        ) : (
          <span className="text-xs text-text-muted">Club default — {fallback.open} to {fallback.close}</span>
        )}
        {error && <span className="text-xs text-danger-strong">{error}</span>}
      </div>
    </div>
  );
}

/**
 * The six court-box and identification numbers.
 *
 * Served by GET /admin/settings since the programme added them, and until now absent
 * from this page — an admin could change none of them. Bounds are the API's own
 * (AdminConfigEndpoints.ValidateDeviceNumbers); the cue window is additionally capped
 * at the forward window here because the API refuses the pair otherwise, and a refusal
 * after Save is a worse place to learn that than a disabled spinner.
 */
function DeviceNumbersSection({ settings, onChange }: { settings: AdminSettings; onChange: (next: AdminSettings) => void }) {
  const set = (patch: Partial<AdminSettings>) => onChange({ ...settings, ...patch });
  const complaint = deviceNumbersComplaint(settings);
  // The two fields below that a door reads as well as a box, said on the fields themselves.
  // Both are named for courts and filed under this heading, and under the default door policy
  // the pair of them is how early a booking QR opens a DOOR — so an admin lengthening the
  // boxes' outage cushion widened every door in the club with nothing on screen saying so.
  const doorReach = describeCourtSettingDoorReach(settings.gate_access_policy);
  return (
    <Card className="space-y-5">
      <h2 className="text-base font-semibold">Court boxes &amp; identification</h2>
      <p className="text-sm text-text-secondary">
        How the boxes at the courts behave. Boxes pick a change up on their next heartbeat.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Walk-up maximum (minutes)" hint="1–90. The most court time a walk-up can buy at the box in one go; 90 is the relay's hard cap.">
          <Input type="number" min={1} max={90} value={settings.walk_up_max_minutes}
            onChange={(e) => set({ walk_up_max_minutes: Number(e.target.value) })} />
        </Field>
        {/* 3600 was offered and 300 was what the box ran: the firmware clamps its own
            cadence to 15-300, and the Devices page then reported the whole fleet
            offline for most of every interval (review finding 22). The field states
            the range the box will honour, and the API holds the same bound. */}
        {/* The "three missed beats" half of this hint was true only above 60 s. Below it the
            180-second floor takes over, so an admin lowering the interval to detect an
            outage faster got none of the improvement and no explanation — at 15 s the box
            reported offline_after_seconds: 180, not 45. The floor is deliberate (a club on
            the 15-second minimum must not be called offline after 45 seconds of ordinary
            jitter), so the hint states it and the derived line below says what THIS value
            actually buys, rather than making the admin work it out. */}
        <Field
          label="Heartbeat interval (seconds)"
          hint={`15–300. How often a box calls in for its roster and button map. A box clamps anything outside 15–300 to that range, so a larger number here is not what it would run. The Devices page calls a box offline after three missed beats or ${OFFLINE_FLOOR_SECONDS / 60} minutes, whichever is longer — at ${settings.heartbeat_seconds}s that is ${describeOfflineAfter(settings.heartbeat_seconds)}.`}
        >
          <Input type="number" min={15} max={300} value={settings.heartbeat_seconds}
            onChange={(e) => set({ heartbeat_seconds: Number(e.target.value) })} />
        </Field>
        {/*
            These two were described the wrong way round, and the one whose hint promised to
            control how early the lights come on is not the one that does.

            Measured against a real box and a real booking: with the forward window at 1440
            and the cue at 10, a scan 19.5 minutes before the start answered `too_early`;
            raising the CUE to 30 lit the court, and raising it to 900 lit a court 13.8 hours
            early. The forward window only decides whether the box recognises the booking at
            all — outside it the answer is `no_booking` — which is what
            `CourtActivationService.WindowAsync` and `DeviceActivateEndpoint` have always
            done. An admin who wanted members to open the court half an hour early edited the
            field that said so, saw "Settings saved.", and changed nothing.

            So the cue is now named as the one that switches the lights, and the forward
            window is named as recognition. `feature-spec.md` and `lights-controller.md`
            describe the mechanism; only this screen described it backwards.
        */}
        <Field
          label="Booking lookahead at the box (minutes)"
          hint="1–1440. How far ahead the box recognises a booking at all. Outside this the box answers “no booking behind this code”; inside it, but before the lights cue below, it answers “too early” and says when to come back. This does NOT decide when the lights come on."
        >
          <Input type="number" min={1} max={1440} value={settings.activation_forward_window_minutes}
            onChange={(e) => set({ activation_forward_window_minutes: Number(e.target.value) })} />
        </Field>
        <Field
          label="Lights on this early (minutes before a booking)"
          hint={`0–${settings.activation_forward_window_minutes}. This is the one that decides how early a scan actually switches a booking's lights on. Must not exceed the booking lookahead. ${doorReach}`}
        >
          <Input type="number" min={0} max={settings.activation_forward_window_minutes} value={settings.activation_cue_window_minutes}
            onChange={(e) => set({ activation_cue_window_minutes: Number(e.target.value) })} />
        </Field>
        <Field label="Court code lifetime (seconds)" hint="15–3600. How long a member's walk-up code stays valid; the app fetches a new one as it runs out.">
          <Input type="number" min={15} max={3600} value={settings.qr_lifetime_seconds}
            onChange={(e) => set({ qr_lifetime_seconds: Number(e.target.value) })} />
        </Field>
        <Field
          label="Offline roster reach (minutes)"
          hint={`5–1440. How far ahead a box's cached roster lets it admit booked members when the API is unreachable. ${doorReach}`}
        >
          <Input type="number" min={5} max={1440} value={settings.roster_window_minutes}
            onChange={(e) => set({ roster_window_minutes: Number(e.target.value) })} />
        </Field>
        {/* Here rather than in the Door gates block: the cooldown bounds the "not reporting"
            mail for every board the club has, court boxes included, and filing it with the
            doors would have read as a door setting an admin chasing a noisy box would never
            find. The second clause is a separate rule rather than a consequence of this one,
            and is said here because an admin who does not know it reads a silent unnamed door
            as a cooldown that is too long. */}
        <Field
          label="Alert cooldown (minutes)"
          hint={`${DEVICE_ALERT_COOLDOWN_MIN_MINUTES}–${DEVICE_ALERT_COOLDOWN_MAX_MINUTES}. At most one “not reporting” email per board in this many minutes; a door nobody has named never alerts.`}
        >
          <Input type="number" min={DEVICE_ALERT_COOLDOWN_MIN_MINUTES} max={DEVICE_ALERT_COOLDOWN_MAX_MINUTES}
            value={settings.device_alert_cooldown_minutes}
            onChange={(e) => set({ device_alert_cooldown_minutes: Number(e.target.value) })} />
        </Field>
      </div>
      {complaint && <p className="text-xs text-danger-strong">{complaint}</p>}
    </Card>
  );
}

/**
 * The three door-gate numbers.
 *
 * <p>
 * Its own block rather than three more fields under "Court boxes", because a door and a
 * court box share the key, the heartbeat and nothing else: a gate drives no courts, has no
 * buttons, and its decisions never touch a booking, a check-in, the ledger or the no-show
 * sweep. Filing them together would have put "who may open a door" beside "how early a scan
 * switches the lights on" — two settings that look like one another and are not, which is
 * the shape of the mistake the two activation windows on that block already made once.
 * </p>
 *
 * <p>
 * The offline sentence is at the TOP, before the policy picker, because it is the one thing
 * on this block an admin would not predict from the controls: whichever policy they choose,
 * a door that loses the network falls back to a roster built from bookings, so the open
 * policy silently becomes the strict one. Read after the picker it is a footnote; read
 * before it, it is the context the choice is made in.
 * </p>
 */
function GateSection({ settings, onChange }: { settings: AdminSettings; onChange: (next: AdminSettings) => void }) {
  const set = (patch: Partial<AdminSettings>) => onChange({ ...settings, ...patch });
  const complaint = gateSettingsComplaint(settings);
  return (
    <Card className="space-y-5">
      <h2 className="text-base font-semibold">Door gates</h2>
      <p className="text-sm text-text-secondary">
        How the doors behave. Doors pick a change up on their next heartbeat.{" "}
        {gateOfflineFallbackNotice()}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field
          label="Unlock time (seconds)"
          hint={`${GATE_UNLOCK_MIN_SECONDS}–${GATE_UNLOCK_MAX_SECONDS}. How long the lock is released each time a door opens. A door never holds it open longer than ${GATE_UNLOCK_MAX_SECONDS} seconds, whatever is set here.`}
        >
          <Input type="number" min={GATE_UNLOCK_MIN_SECONDS} max={GATE_UNLOCK_MAX_SECONDS} value={settings.gate_unlock_seconds}
            onChange={(e) => set({ gate_unlock_seconds: Number(e.target.value) })} />
        </Field>
        <Field
          label="Who may open a door"
          hint={describeGatePolicy(settings.gate_access_policy, settings.gate_early_entry_minutes)}
        >
          <select
            value={settings.gate_access_policy}
            onChange={(e) => set({ gate_access_policy: e.target.value as GateAccessPolicy })}
            className={fieldClassName}
          >
            {GATE_ACCESS_POLICIES.map((policy) => (
              <option key={policy} value={policy}>{GATE_POLICY_LABELS[policy]}</option>
            ))}
          </select>
        </Field>
        {/* The hint follows the POLICY, because this number does two different jobs under the
            two of them. It used to say "How long before a booking starts its holder may come
            in" flatly, which is the door under `booking_window` and the offline roster plus a
            floor under `active_member` — where the door's real horizon is the wider of this
            and what the member's phone shows. At the API's own defaults that made the screen
            say 30 while the door opened at 130. */}
        <Field
          label="Early entry (minutes before a booking)"
          hint={`${GATE_EARLY_ENTRY_MIN_MINUTES}–${GATE_EARLY_ENTRY_MAX_MINUTES}. ${describeEarlyEntry(settings.gate_access_policy)}`}
        >
          <Input type="number" min={GATE_EARLY_ENTRY_MIN_MINUTES} max={GATE_EARLY_ENTRY_MAX_MINUTES} value={settings.gate_early_entry_minutes}
            onChange={(e) => set({ gate_early_entry_minutes: Number(e.target.value) })} />
        </Field>
      </div>
      {/* The answer itself, rather than three hints and an arithmetic exercise. Three fields on
          two blocks decide it, two of them under a heading that says Court boxes, and under the
          default policy the answer is none of the three — which is exactly how this screen came
          to state a door's early-entry window as 30 while the door's was 130. */}
      <p className="text-sm font-medium text-text-primary">
        {describeDoorBookingHorizon(doorBookingHorizonMinutes(settings))}
      </p>
      {complaint && <p className="text-xs text-danger-strong">{complaint}</p>}
    </Card>
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
        <Field label="Price per slice (credits)" hint="Credits, not rand. Members are charged this per slice; rand only ever buys credits.">
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
      <Input type="number" min={0} aria-label={`${court.name} price per slice (credits)`} value={price} onChange={(e) => setPrice(Number(e.target.value))} disabled={!court.is_active} />
      <Button variant="outline" onClick={save} disabled={!dirty || busy || !court.is_active}>Save</Button>
      {court.is_active ? (
        <ConfirmButton
          idleLabel="Deactivate"
          confirmLabel="Confirm deactivate"
          onConfirm={remove}
          tone="danger"
          className="h-11 px-4"
        />
      ) : (
        <span className="text-xs text-text-muted px-3">Inactive</span>
      )}
    </div>
  );
}
