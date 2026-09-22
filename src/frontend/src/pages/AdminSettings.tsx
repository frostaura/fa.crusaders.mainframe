import {
  createContext, useCallback, useContext, useEffect, useState, cloneElement, isValidElement, useId,
} from "react";
import { Link } from "react-router-dom";
import { endpoints, GATE_ACCESS_POLICIES, type AdminSettings, type AdminCourt, type GateAccessPolicy } from "../lib/api";
import {
  DAY_KEYS, DAY_NAMES, DEVICE_ALERT_COOLDOWN_MAX_MINUTES, DEVICE_ALERT_COOLDOWN_MIN_MINUTES,
  DOOR_BOOKING_HORIZON_MAX_MINUTES,
  GATE_EARLY_ENTRY_MAX_MINUTES, GATE_EARLY_ENTRY_MIN_MINUTES,
  GATE_UNLOCK_MAX_SECONDS, GATE_UNLOCK_MIN_SECONDS, OFFLINE_FLOOR_SECONDS, describeOfflineAfter,
  CLUB_CONTACT_EMAIL_MAX_LENGTH, CLUB_CONTACT_PHONE_MAX_LENGTH,
  DOOR_LOG_RETENTION_MAX_DAYS, DOOR_LOG_RETENTION_MIN_DAYS,
  DOOR_REFUSAL_SPIKE_MAX_COUNT, DOOR_REFUSAL_SPIKE_MAX_MINUTES,
  DOOR_REFUSAL_SPIKE_MIN_COUNT, DOOR_REFUSAL_SPIKE_MIN_MINUTES,
  deviceNumbersComplaint, doorBookingHorizonBasis, doorBookingHorizonMinutes, doorSettingComplaints,
  formatDayHours,
  gateSettingComplaints, operatingHoursComplaint, parseDayHours, settingAnchorId, timezoneOptions,
  type DayHours, type DayKey, type SettingComplaint,
} from "../lib/tenantSettings";
// eco — ruling 13. The bounds, the labels and the sentences for every number this release
// made configurable, in one module so a field's `min` cannot drift from the bound the save
// is validated against.
import {
  ACTION_GLYPHS_HINT, ACTION_GLYPH_CHOICES, ACTION_GLYPH_LABEL, CAP_RULES, DEVICE_TIMING_RULES,
  ECO_SETTING_LABELS, MEMBER_TRACE_HINT, MEMBER_TRACE_LABEL, MONITORING_RULES, REALTIME_RULES,
  SCHEDULE_RULES, ecoSettingComplaints, type NumericSettingRule,
} from "../lib/ecoSettings";
import {
  GATE_POLICY_LABELS, describeCourtSettingDoorReach, describeDoorBookingHorizon, describeEarlyEntry,
  describeGatePolicy, gateOfflineFallbackNotice,
} from "../lib/gateCopy";
// doors: admin
import { doorRetentionNotice } from "../lib/doorsCopy";
import { describeDeviceError } from "../lib/deviceErrors";
import { focusFragmentTarget } from "../lib/routeAnnouncer";
import { cn } from "../lib/utils";
import { Card } from "../components/Card";
import { Button, Input, Label, fieldClassName } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { useToast } from "../components/Toast";
import { AlertCircle } from "lucide-react";

const minToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const hhmmToMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};

/**
 * <b>An empty box is not zero.</b> (B5 / C11)
 *
 * <p>
 * Every numeric field on this page was bound with
 * <code>onChange={(e) =&gt; set({ x: Number(e.target.value) })}</code>, and
 * <code>Number("")</code> is <code>0</code>. Clearing a field to retype it therefore SET the
 * setting to zero, silently: for <code>gate_early_entry_minutes</code> zero is in range and
 * would have been saved — a club that quietly stopped letting anyone in before their booking
 * — and for the rest it tripped a bound the admin had not typed, killed Save, and said
 * nothing about why.
 * </p>
 *
 * <p>
 * <code>NaN</code> is the sentinel for "the box is empty". It renders as an empty input, it
 * fails every <code>Number.isInteger</code> bound, and — because Save cannot be pressed while
 * any field holds one — it can never reach the wire, where <code>JSON.stringify</code> would
 * turn it into <code>null</code>.
 * </p>
 */
const toNumber = (raw: string): number => (raw.trim() === "" ? Number.NaN : Number(raw));

/** What a number input shows: its value, or an empty box for a field that has been cleared. */
const shown = (value: number): number | string => (Number.isFinite(value) ? value : "");

/** That same value where a NUMBER is needed — a hint, a bound on a neighbour — with a floor. */
const orElse = (value: number | undefined, fallback: number): number =>
  (Number.isFinite(value) ? (value as number) : fallback);

/**
 * Every settings key that has a field on this page, and the caption that field carries.
 *
 * <p>
 * One table rather than a label written at the call site and a second copy wherever a
 * complaint has to name the field. The error summary beside Save reads its link text from
 * here, so an admin sent back to a field is sent back to it by the words the field actually
 * shows — <code>settings-door-validation.test.tsx</code> pins that by reading each caption
 * off the rendered <code>&lt;label for&gt;</code> rather than restating it.
 * </p>
 */
const SETTING_LABELS: Record<string, string> = {
  advance_booking_days: "Reserve window (days ahead)",
  slice_minutes: "Slice length (minutes)",
  timezone: "Timezone",
  penalty_pct: "Penalty (% of slice price)",
  grace_window_minutes: "Grace window (minutes)",
  penalty_window_minutes: "Late-cancel window (minutes)",
  credits_per_zar_regular: "Credits per R1 — members",
  credits_per_zar_league: "Credits per R1 — league / over-65",
  topup_block_zar: "Top-up block (R)",
  topup_max_zar_per_member: "Top-up cap per member (R)",
  member_per_day_max_minutes: "Court time per member per day (minutes)",
  peak_hours: "Peak hours",
  peak_advance_hours_for_regular: "Peak opens to everyone (hours before start)",
  walk_up_max_minutes: "Walk-up maximum (minutes)",
  heartbeat_seconds: "Heartbeat interval (seconds)",
  activation_forward_window_minutes: "Booking lookahead at the box (minutes)",
  activation_cue_window_minutes: "Lights on this early (minutes before a booking)",
  qr_lifetime_seconds: "Court code lifetime (seconds)",
  roster_window_minutes: "Offline roster reach (minutes)",
  device_alert_cooldown_minutes: "Alert cooldown (minutes)",
  gate_unlock_seconds: "Unlock time (seconds)",
  gate_access_policy: "Who may open a door",
  gate_early_entry_minutes: "Early entry (minutes before a booking)",
  door_log_retention_days: "Keep door scans for (days)",
  door_refusal_spike_count: "Refusal spike (scans)",
  door_refusal_spike_minutes: "Refusal spike window (minutes)",
  club_contact_phone: "Club contact number",
  club_contact_email: "Club contact email",
  retention_years: "Keep usage history for (years)",
  no_show_lookback_days: "No-show sweep looks back (days)",
  // eco — ruling 13. Every number this release made configurable, spread in from the module
  // that also holds its bound and its sentence, so a key cannot have a row here and no rule
  // there (or the reverse, which is the one that ships).
  ...ECO_SETTING_LABELS,
};

/** The five above that a person types words into rather than a number. */
const TEXT_SETTINGS = new Set([
  "timezone", "peak_hours", "gate_access_policy", "club_contact_phone", "club_contact_email",
]);

const NUMERIC_SETTING_KEYS = Object.keys(SETTING_LABELS).filter((key) => !TEXT_SETTINGS.has(key));

/** A reason this page cannot be saved, with the field it belongs to and that field's caption. */
type Blocker = SettingComplaint & { label: string };

/** Which numeric fields have been emptied — the one complaint no bound-check can phrase. */
function emptyNumberComplaints(settings: AdminSettings): SettingComplaint[] {
  const document_ = settings as unknown as Record<string, unknown>;
  return NUMERIC_SETTING_KEYS
    .filter((key) => typeof document_[key] === "number" && !Number.isFinite(document_[key]))
    .map((key) => ({
      key,
      message: `${SETTING_LABELS[key]} needs a number — an empty box is not the same as 0.`,
    }));
}

/**
 * Everything standing between this page and a save, in the order an admin would meet it
 * reading down the page.
 *
 * <p>
 * An emptied field WINS over the bound-check for the same key. Both are true of a cleared
 * box — <code>Number.isInteger(NaN)</code> is false, so the range complaint fires too — but
 * "Unlock time has to be a whole number between 1 and 30" is a confusing thing to be told
 * about a field you have just emptied, and two messages on one input is worse than one.
 * </p>
 */
function blockersOf(
  settings: AdminSettings,
  hours: { day: DayKey; message: string } | null,
): Blocker[] {
  const empties = emptyNumberComplaints(settings);
  const emptied = new Set(empties.map((complaint) => complaint.key));
  const cooldown = deviceNumbersComplaint(settings);
  const rules: SettingComplaint[] = [
    ...(cooldown ? [{ key: "device_alert_cooldown_minutes", message: cooldown }] : []),
    ...gateSettingComplaints(settings),
    ...doorSettingComplaints(settings),
    // eco — the new keys' bounds, plus the one cross-field rule whose failure appears weeks
    // later: a member booking past the horizon repeating bookings are written to.
    ...ecoSettingComplaints(settings as unknown as Record<string, unknown>),
  ].filter((complaint) => !emptied.has(complaint.key));

  const dayRow: Blocker[] = hours
    ? [{
        key: `operating_hours_${hours.day}`,
        label: `${DAY_NAMES[hours.day]} opening hours`,
        message: hours.message,
      }]
    : [];

  return [
    ...dayRow,
    ...[...empties, ...rules].map((complaint) => ({
      ...complaint,
      label: SETTING_LABELS[complaint.key] ?? complaint.key,
    })),
  ];
}

/**
 * C14 — this page is a document, and a document has sections you can go to.
 *
 * <p>
 * <b>The measurement.</b> Reviewer C counted the tab stops from the top of the document to
 * the first door setting: <b>seventy-six</b>. The page is nine cards and about thirty fields
 * long, the door numbers are seventh, and every field above them is a stop. A keyboard user
 * sent here by the doors page's "change how long the lock is released" link — which is the
 * journey this screen exists to be the end of — paid for the entire booking, credits and
 * court-box blocks first, every time.
 * </p>
 *
 * <p>
 * Two halves, and both are needed. The cards become <code>&lt;section&gt;</code>s named by
 * their own heading, so a screen reader can list them and jump between them with the keys it
 * already has. And the page grows a plain in-page nav at the top, so a KEYBOARD user — who
 * has no such list — reaches any section in at most nine stops from the skip link. The
 * per-setting <code>#setting-*</code> deep link is unchanged and still lands on the field
 * itself; this is the coarser thing for somebody who does not know which field they want.
 * </p>
 */
const SECTION_IDS = {
  booking: "settings-booking",
  hours: "settings-opening-hours",
  policy: "settings-no-show",
  credits: "settings-credits",
  courtAccess: "settings-court-access",
  boxes: "settings-court-boxes",
  doors: "settings-door-gates",
  records: "settings-records",
  screens: "settings-box-screens",
  limits: "settings-limits",
  monitoring: "settings-monitoring",
  courts: "settings-courts",
} as const;

/** The nav's running order, which is the page's own order. Captions are the headings verbatim. */
const SECTION_ORDER: ReadonlyArray<readonly [string, string]> = [
  [SECTION_IDS.booking, "Booking"],
  [SECTION_IDS.hours, "Opening hours"],
  [SECTION_IDS.policy, "No-show & cancellation"],
  [SECTION_IDS.credits, "Credits & top-ups"],
  [SECTION_IDS.courtAccess, "Court access"],
  [SECTION_IDS.boxes, "Court boxes & identification"],
  [SECTION_IDS.doors, "Door gates"],
  [SECTION_IDS.records, "Records"],
  [SECTION_IDS.screens, "Box screens & scanning"],
  [SECTION_IDS.limits, "Limits & confirmations"],
  [SECTION_IDS.monitoring, "Monitoring & live updates"],
  [SECTION_IDS.courts, "Courts"],
];

/**
 * One card, as a named region.
 *
 * <p>
 * <code>aria-labelledby</code> pointing at the card's own <code>&lt;h2&gt;</code> rather than
 * an <code>aria-label</code> repeating it: one string, on screen, and a rename cannot leave
 * the region announcing the old name.
 * </p>
 */
function SettingsSection({ id, title, beside, className, children }: {
  id: string;
  title: string;
  /** Anything that sits on the heading's own row — the Courts block's count. */
  beside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24">
      <Card className={cn("space-y-5", className)}>
        {beside ? (
          <div className="flex items-baseline justify-between gap-3">
            <h2 id={`${id}-heading`} className="text-base font-semibold">{title}</h2>
            {beside}
          </div>
        ) : (
          <h2 id={`${id}-heading`} className="text-base font-semibold">{title}</h2>
        )}
        {children}
      </Card>
    </section>
  );
}

/**
 * The jump nav — real links, and a jump that moves FOCUS rather than only the scroll.
 *
 * <p>
 * A bare fragment navigation scrolls and leaves focus at the top of the document, which is
 * C15's finding on <code>/profile#door-history</code> in a different place: the person who
 * most needs the jump is the one it does nothing for. {@link focusFragmentTarget} is the same
 * function the router uses for a hash arriving on a route, so the two behave identically and
 * there is one <code>scroll-margin-top</code> rule to keep the heading clear of the header.
 * </p>
 */
function SectionJumpNav() {
  return (
    <nav aria-label="Jump to section" className="rounded-lg border border-border bg-bg-surface px-3 py-2">
      <h2 className="sr-only">Jump to section</h2>
      <ul className="flex flex-wrap gap-x-1 gap-y-1">
        {SECTION_ORDER.map(([id, caption]) => (
          <li key={id}>
            <a
              href={`#${id}`}
              onClick={(e) => { e.preventDefault(); focusFragmentTarget(`#${id}`); }}
              className="inline-flex items-center min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] rounded-lg px-2 text-sm text-accent-strong underline decoration-accent-strong/40 underline-offset-2 hover:bg-bg-muted"
            >{caption}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** What every {@link Field} on the page needs to know that its own props do not carry. */
type FieldState = { errors: Record<string, string>; highlighted: string | null };

const FieldStateContext = createContext<FieldState>({ errors: {}, highlighted: null });

/** How long a deep-linked field stays ringed, in ms. Long enough to be seen, short enough to leave. */
const HIGHLIGHT_MS = 2500;

const HIGHLIGHT_CLASS = "rounded-lg ring-2 ring-accent-strong ring-offset-2";

/**
 * Put one setting in front of the admin: scroll to it, focus its control, and say which.
 *
 * <p>
 * The checkbox is skipped deliberately. A weekday row's first control is "Monday has its own
 * hours", and an admin sent there by a complaint about the CLOSING TIME wants the closing
 * time, not the switch that would turn the row off altogether.
 * </p>
 */
function focusSettingElement(anchorId: string): boolean {
  const wrapper = document.getElementById(anchorId);
  if (!wrapper) return false;
  wrapper.scrollIntoView?.({ block: "center" });
  const control = wrapper.querySelector<HTMLElement>('input:not([type="checkbox"]), select, textarea')
    ?? wrapper.querySelector<HTMLElement>("input");
  control?.focus({ preventScroll: true });
  return true;
}

/**
 * The <code>#setting-&lt;key&gt;</code> deep link, and the same jump used by the error summary. (A9)
 *
 * <p>
 * The doors page's "may not be releasing" signal tells an admin to change the release under
 * Admin settings. It linked to <code>/admin/settings</code>, which is about 5 400 px tall, and
 * left them to find one number among thirty. A hash is the general mechanism — every field
 * with a settings key has an anchor — rather than a special case for the one that prompted it.
 * </p>
 */
function useSettingFocus(ready: boolean) {
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const focusSetting = useCallback((key: string) => {
    const anchorId = settingAnchorId(key);
    if (focusSettingElement(anchorId)) setHighlighted(anchorId);
  }, []);

  // An effect rather than a render-time read on purpose: the hash names an ELEMENT, and the
  // element does not exist until the settings have loaded and the fields are committed.
  useEffect(() => {
    if (!ready) return;
    const fromHash = () => {
      // `slice` rather than `.replace(/^#/, "")`: lizard's lexer reads a regex literal in a
      // .tsx file as division and swallows the rest of the file into this function, which is
      // what failed `make complexity` on the length bound.
      const raw = window.location.hash;
      const hash = raw.startsWith("#") ? raw.slice(1) : raw;
      if (!hash.startsWith("setting-")) return;
      if (focusSettingElement(hash)) setHighlighted(hash);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [ready]);

  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  return { highlighted, focusSetting };
}

/**
 * The three blocks ruling 13 added, and the save bar that ends the document.
 *
 * <p>
 * Lifted out of the page because the page had become a 285-line render — over the gate's 200
 * — and these three are the coherent piece to take: they share a shape (`EcoSection` plus a
 * rules list), they arrived together, and none of the page's own state handling is in them.
 * Every prop here is something the page owns; this component decides nothing.
 * </p>
 */
function EcoSections({ settings, onChange, blockers, saving, onSave, onFocusSetting }: {
  settings: AdminSettings;
  onChange: (next: AdminSettings) => void;
  blockers: Parameters<typeof SaveBar>[0]["blockers"];
  saving: boolean;
  onSave: () => void | Promise<unknown>;
  onFocusSetting: Parameters<typeof SaveBar>[0]["onFocusSetting"];
}) {
  return (
    <>
      <EcoSection
        id={SECTION_IDS.screens}
        title="Box screens & scanning"
        lede="What the court box's screen does, and how long it waits. A box picks these up the next time it calls in, so a change reaches the courts within a minute rather than the moment you save it."
        rules={DEVICE_TIMING_RULES}
        settings={settings}
        onChange={onChange}
      />

      <EcoSection
        id={SECTION_IDS.limits}
        title="Limits & confirmations"
        lede="How much one member may hold in a day, how much an admin may do in one press, and what yes and no look like."
        rules={[...CAP_RULES, ...SCHEDULE_RULES]}
        settings={settings}
        onChange={onChange}
      >
        {/*
          The two caps compose, and neither field alone would say so. A club that sets 4
          slots and leaves the minutes at 60 has set an hour — the most restrictive of the
          two is what a member meets, a group may lower either and may never raise one, and
          admins are exempt from both (ruling 3).
        */}
        <p className="text-sm text-text-secondary">
          {capsSentence(settings)}
        </p>
        {/*
          The other half of item 3, and it is a destination rather than a field: a group may
          LOWER either cap for its own members and may never raise one, so the number above
          is a ceiling and the groups page is where the exceptions to it live. Without this
          link the two halves of one rule sit on two pages that do not mention each other.
        */}
        <p className="text-sm">
          <Link to="/admin/groups" className="inline-flex min-h-11 items-center text-accent-strong">
            Member groups can lower these for their own members
          </Link>
        </p>
        <Field settingKey="action_glyphs" label={SETTING_LABELS.action_glyphs} hint={ACTION_GLYPHS_HINT}>
          <select
            value={settings.action_glyphs ?? "thumbs"}
            onChange={(e) => onChange({ ...settings, action_glyphs: e.target.value as "thumbs" | "marks" })}
            className={fieldClassName}
          >
            {ACTION_GLYPH_CHOICES.map((choice) => (
              <option key={choice} value={choice}>{ACTION_GLYPH_LABEL[choice]}</option>
            ))}
          </select>
        </Field>
      </EcoSection>

      <EcoSection
        id={SECTION_IDS.monitoring}
        title="Monitoring & live updates"
        lede="How long the club keeps what its boards report, and how screens that show it stay current."
        rules={[...MONITORING_RULES, ...REALTIME_RULES]}
        settings={settings}
        onChange={onChange}
      >
        {/*
          A switch rather than a number, and it is the most consequential control on this
          page: off, the per-person night page is not there at all. Rendered only where the
          API actually serves the key, because a switch bound to `undefined` is a switch
          that reads "off" about a feature that is on.
        */}
        {settings.member_trace_enabled !== undefined && (
          <Field settingKey="member_trace_enabled" label={MEMBER_TRACE_LABEL} hint={MEMBER_TRACE_HINT}>
            <label className="inline-flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={settings.member_trace_enabled}
                onChange={(e) => onChange({ ...settings, member_trace_enabled: e.target.checked })}
              />
              {settings.member_trace_enabled ? "On — every look is recorded" : "Off — the page is not there"}
            </label>
          </Field>
        )}
        <SaveBar blockers={blockers} saving={saving} onSave={onSave} onFocusSetting={onFocusSetting} />
      </EcoSection>
    </>
  );
}

export default function AdminSettingsPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [courts, setCourts] = useState<AdminCourt[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const { highlighted, focusSetting } = useSettingFocus(settings !== null);

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
  const blockers = blockersOf(settings, hoursComplaint);
  const fieldState: FieldState = {
    errors: Object.fromEntries(blockers.map((blocker) => [blocker.key, blocker.message])),
    highlighted,
  };

  return (
    <FieldStateContext.Provider value={fieldState}>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold">Admin · Settings</h1>
          {/*
            "Tenant" is our word for a row in our database. An admin here is a club
            volunteer, and this is the first line of the screen they read (A9).
          */}
          <p className="text-sm text-text-secondary">Court schedule, booking limits, penalty policy and court-box behaviour for this club.</p>
        </div>

        <SectionJumpNav />

        <SettingsSection id={SECTION_IDS.booking} title="Booking">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field settingKey="advance_booking_days" label={SETTING_LABELS.advance_booking_days} hint="0–365. Members can only book up to this many days in advance.">
              <Input type="number" min={0} max={365} value={shown(settings.advance_booking_days)}
                onChange={(e) => setSettings({ ...settings, advance_booking_days: toNumber(e.target.value) })} />
            </Field>
            <Field settingKey="slice_minutes" label={SETTING_LABELS.slice_minutes} hint="Each booking is one or more slices, e.g. 30 min.">
              <Input type="number" min={5} max={240} step={5} value={shown(settings.slice_minutes)}
                onChange={(e) => setSettings({ ...settings, slice_minutes: toNumber(e.target.value) })} />
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
              settingKey="timezone"
              label={SETTING_LABELS.timezone}
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
        </SettingsSection>

        <OperatingHoursSection settings={settings} onChange={setSettings} />

        <SettingsSection id={SECTION_IDS.policy} title="No-show & cancellation policy">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field settingKey="penalty_pct" label={SETTING_LABELS.penalty_pct}>
              <Input type="number" min={0} max={100} value={shown(settings.penalty_pct)}
                onChange={(e) => setSettings({ ...settings, penalty_pct: toNumber(e.target.value) })} />
            </Field>
            <Field settingKey="grace_window_minutes" label={SETTING_LABELS.grace_window_minutes} hint="After slot start, before a no-show triggers.">
              <Input type="number" min={0} max={60} value={shown(settings.grace_window_minutes)}
                onChange={(e) => setSettings({ ...settings, grace_window_minutes: toNumber(e.target.value) })} />
            </Field>
            <Field settingKey="penalty_window_minutes" label={SETTING_LABELS.penalty_window_minutes} hint="Cancellations within this many minutes of start incur the penalty.">
              <Input type="number" min={0} max={1440} value={shown(settings.penalty_window_minutes)}
                onChange={(e) => setSettings({ ...settings, penalty_window_minutes: toNumber(e.target.value) })} />
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection id={SECTION_IDS.credits} title="Credits & top-ups">
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
            <Field settingKey="credits_per_zar_regular" label={SETTING_LABELS.credits_per_zar_regular} hint="R100 at 1.6 gives 160 credits.">
              <Input type="number" min={0.01} max={1000} step={0.01} value={shown(settings.credits_per_zar_regular)}
                onChange={(e) => setSettings({ ...settings, credits_per_zar_regular: toNumber(e.target.value) })} />
            </Field>
            <Field settingKey="credits_per_zar_league" label={SETTING_LABELS.credits_per_zar_league} hint="R100 at 2.4 gives 240 credits.">
              <Input type="number" min={0.01} max={1000} step={0.01} value={shown(settings.credits_per_zar_league)}
                onChange={(e) => setSettings({ ...settings, credits_per_zar_league: toNumber(e.target.value) })} />
            </Field>
            <Field settingKey="topup_block_zar" label={SETTING_LABELS.topup_block_zar} hint="Members top up in multiples of this.">
              <Input type="number" min={1} max={100000} value={shown(settings.topup_block_zar)}
                onChange={(e) => setSettings({ ...settings, topup_block_zar: toNumber(e.target.value) })} />
            </Field>
            <Field settingKey="topup_max_zar_per_member" label={SETTING_LABELS.topup_max_zar_per_member} hint="Must be at least one block, or no top-up is ever legal.">
              <Input type="number" min={1} max={100000} value={shown(settings.topup_max_zar_per_member)}
                onChange={(e) => setSettings({ ...settings, topup_max_zar_per_member: toNumber(e.target.value) })} />
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection id={SECTION_IDS.courtAccess} title="Court access">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field settingKey="member_per_day_max_minutes" label={SETTING_LABELS.member_per_day_max_minutes} hint="0 turns the cap off. A slot starting today is allowed over the cap if the court is otherwise free.">
              <Input type="number" min={0} max={1440} step={15} value={shown(settings.member_per_day_max_minutes)}
                onChange={(e) => setSettings({ ...settings, member_per_day_max_minutes: toNumber(e.target.value) })} />
            </Field>
            <Field settingKey="peak_hours" label={SETTING_LABELS.peak_hours} hint="Reserved for league and over-65 members. Format 16:00-19:00.">
              <Input type="text" value={settings.peak_hours}
                onChange={(e) => setSettings({ ...settings, peak_hours: e.target.value })} />
            </Field>
            <Field settingKey="peak_advance_hours_for_regular" label={SETTING_LABELS.peak_advance_hours_for_regular} hint="An empty peak slot opens to all members this many hours before it begins.">
              <Input type="number" min={0} max={336} value={shown(settings.peak_advance_hours_for_regular)}
                onChange={(e) => setSettings({ ...settings, peak_advance_hours_for_regular: toNumber(e.target.value) })} />
            </Field>
          </div>
        </SettingsSection>

        <DeviceNumbersSection settings={settings} onChange={setSettings} />

        <GateSection settings={settings} onChange={setSettings} />

        <SettingsSection id={SECTION_IDS.records} title="Records">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field settingKey="retention_years" label={SETTING_LABELS.retention_years}>
              <Input type="number" min={1} max={50} value={shown(settings.retention_years)}
                onChange={(e) => setSettings({ ...settings, retention_years: toNumber(e.target.value) })} />
            </Field>
            <Field settingKey="no_show_lookback_days" label={SETTING_LABELS.no_show_lookback_days} hint="Bounds how far back the sweep reaches, so switching it on cannot post a backlog of historical no-shows at once.">
              <Input type="number" min={1} max={365} value={shown(settings.no_show_lookback_days)}
                onChange={(e) => setSettings({ ...settings, no_show_lookback_days: toNumber(e.target.value) })} />
            </Field>
          </div>
        </SettingsSection>

        {/* eco — ruling 13's three new blocks, between Records and Courts. Save moves to the
            bottom of the last of them, so it is still the last thing on the document. */}
        <EcoSections
          settings={settings}
          onChange={setSettings}
          blockers={blockers}
          saving={saving}
          onSave={save}
          onFocusSetting={focusSetting}
        />

        <CourtsSection courts={courts} reload={load} />
      </div>
    </FieldStateContext.Provider>
  );
}

/**
 * Save, and — when it cannot save — the reason, in reach of both the pointer and the keyboard.
 *
 * <p>
 * <b>Why Save is not <code>disabled</code>.</b> A disabled button is removed from the tab
 * order, so the one control carrying the explanation was the one control a keyboard user
 * could not reach; it also took the browser's own "this is off" styling, which measured
 * 2.27:1 on its label. <code>aria-disabled</code> says the same thing to a screen reader,
 * keeps the button focusable, and leaves the press free to do something useful — which here
 * is to take the admin to the field that stopped it. (B5)
 * </p>
 *
 * <p>
 * <b>Why the summary exists.</b> Save is roughly 5 400 px below the door fields. "It is off
 * and you may scroll up to find out why" is not an explanation, so every bad field is named
 * here, in the words its own caption uses, with a link that focuses it. (C11)
 * </p>
 *
 * <p>
 * The blocked treatment is <code>warning.strong</code> on <code>warning.soft</code> with a
 * <code>warning.strong</code> boundary — 4.86:1 for the label and 5.07:1 for the edge against
 * the white card, both measured in <code>tokens.test.ts</code>, against WCAG 2.1's 4.5:1 for
 * text and 3:1 for a control's boundary.
 * </p>
 */
function SaveBar({ blockers, saving, onSave, onFocusSetting }: {
  blockers: Blocker[];
  saving: boolean;
  onSave: () => void;
  onFocusSetting: (key: string) => void;
}) {
  const summaryId = useId();
  const [announcement, setAnnouncement] = useState("");
  const blocked = blockers.length > 0;

  const press = () => {
    if (!blocked) {
      setAnnouncement("");
      onSave();
      return;
    }
    const first = blockers[0];
    setAnnouncement(`Settings cannot be saved yet. Moved to ${first.label}.`);
    onFocusSetting(first.key);
  };

  return (
    <div className="space-y-3">
      {blocked && (
        <div id={summaryId} className="rounded-lg border border-warning-strong bg-warning-soft p-3 text-sm text-warning-strong">
          <p className="font-medium">
            {blockers.length} {blockers.length === 1 ? "setting needs" : "settings need"} fixing before this can be saved:
          </p>
          <ul className="mt-2 space-y-1 list-disc pl-5">
            {blockers.map((blocker) => (
              <li key={blocker.key}>
                {/*
                  A real link with a real href, so it can be tabbed to and read as a link —
                  but the jump is ours, because focusing the input is the point and a bare
                  fragment navigation only scrolls.
                */}
                <a
                  href={`#${settingAnchorId(blocker.key)}`}
                  className="underline font-medium"
                  onClick={(e) => { e.preventDefault(); onFocusSetting(blocker.key); }}
                >{blocker.label}</a>
                {" — "}{blocker.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* The press itself, announced: a control that swallows a press with no feedback is
          indistinguishable, from the person's side, from a broken page. */}
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      <div className="flex justify-end">
        <Button
          onClick={press}
          disabled={saving}
          aria-disabled={blocked || undefined}
          aria-describedby={blocked ? summaryId : undefined}
          className={blocked ? "bg-warning-soft text-warning-strong border-warning-strong hover:bg-warning-soft/70" : undefined}
        >{saving ? "Saving…" : "Save settings"}</Button>
      </div>
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
    <SettingsSection id={SECTION_IDS.hours} title="Opening hours">
      <p className="text-sm text-text-secondary">
        When members can book. A day left on the club default uses <strong className="text-text-primary">Day starts</strong> and{" "}
        <strong className="text-text-primary">Day ends</strong> above ({minToHHMM(settings.day_start_minute)}–{minToHHMM(settings.day_end_minute)}).
        {/* "the API enforces" is our word for our server. A club volunteer reads the booking
            rules, not an interface. (A9) */}
        {" "}These are the hours the booking grid draws and the booking rules enforce — a slot outside them is refused, and a walk-up at the box is cut short at closing.
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
    </SettingsSection>
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
  const shownHours = hours ?? fallback;
  const { highlighted } = useContext(FieldStateContext);
  // The row is a setting too, as far as the summary beside Save is concerned: a bad Saturday
  // is six cards above the button it switches off.
  const anchorId = settingAnchorId(`operating_hours_${day}`);
  return (
    <div
      id={anchorId}
      className={`scroll-mt-24 grid grid-cols-1 sm:grid-cols-[120px_auto_1fr] gap-2 sm:items-center p-3 rounded-md border border-border ${highlighted === anchorId ? HIGHLIGHT_CLASS : ""}`}
    >
      <span className="text-sm font-medium text-text-primary">{name}</span>
      <label className="flex items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={custom}
          aria-label={`${name} has its own hours`}
          // Ticking a day starts it at the club default rather than at 00:00, so the
          // first thing an admin sees is the hours that are actually in force for it.
          onChange={(e) => onChange(e.target.checked ? shownHours : null)}
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
              aria-invalid={error ? true : undefined}
              value={shownHours.open}
              onChange={(e) => onChange({ ...shownHours, open: e.target.value })}
            />
            <span className="text-xs text-text-muted">to</span>
            <Input
              type="time"
              className="h-9 w-32"
              aria-label={`${name} closes`}
              aria-invalid={error ? true : undefined}
              value={shownHours.close}
              onChange={(e) => onChange({ ...shownHours, close: e.target.value })}
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
  // The two fields below that a door reads as well as a box, said on the fields themselves.
  // Both are named for courts and filed under this heading, and under the default door policy
  // the pair of them is how early a booking QR opens a DOOR — so an admin lengthening the
  // boxes' outage cushion widened every door in the club with nothing on screen saying so.
  const doorReach = describeCourtSettingDoorReach(settings.gate_access_policy);
  // The cue window's ceiling follows the lookahead, so an emptied lookahead must not leave
  // "0–NaN" on a hint or `max="NaN"` on an input while the admin retypes it.
  const lookahead = orElse(settings.activation_forward_window_minutes, 1440);
  return (
    <SettingsSection id={SECTION_IDS.boxes} title="Court boxes & identification">
      <p className="text-sm text-text-secondary">
        {/* "Picks a change up on their next heartbeat" is a protocol detail wearing a
            sentence. The interval below is where an admin who wants the detail finds it. */}
        How the boxes at the courts behave. A box picks a change up the next time it calls in.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field settingKey="walk_up_max_minutes" label={SETTING_LABELS.walk_up_max_minutes} hint="1–90. The most court time a walk-up can buy at the box in one go; 90 is the relay's hard cap.">
          <Input type="number" min={1} max={90} value={shown(settings.walk_up_max_minutes)}
            onChange={(e) => set({ walk_up_max_minutes: toNumber(e.target.value) })} />
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
          settingKey="heartbeat_seconds"
          label={SETTING_LABELS.heartbeat_seconds}
          hint={`15–300. How often a box calls in for its roster and button map. A box clamps anything outside 15–300 to that range, so a larger number here is not what it would run. The Devices page calls a box offline after three missed beats or ${OFFLINE_FLOOR_SECONDS / 60} minutes, whichever is longer — at ${orElse(settings.heartbeat_seconds, 15)}s that is ${describeOfflineAfter(settings.heartbeat_seconds)}.`}
        >
          <Input type="number" min={15} max={300} value={shown(settings.heartbeat_seconds)}
            onChange={(e) => set({ heartbeat_seconds: toNumber(e.target.value) })} />
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
          settingKey="activation_forward_window_minutes"
          label={SETTING_LABELS.activation_forward_window_minutes}
          hint="1–1440. How far ahead the box recognises a booking at all. Outside this the box answers “no booking behind this code”; inside it, but before the lights cue below, it answers “too early” and says when to come back. This does NOT decide when the lights come on."
        >
          <Input type="number" min={1} max={1440} value={shown(settings.activation_forward_window_minutes)}
            onChange={(e) => set({ activation_forward_window_minutes: toNumber(e.target.value) })} />
        </Field>
        <Field
          settingKey="activation_cue_window_minutes"
          label={SETTING_LABELS.activation_cue_window_minutes}
          hint={`0–${lookahead}. This is the one that decides how early a scan actually switches a booking's lights on. Must not exceed the booking lookahead. ${doorReach}`}
        >
          <Input type="number" min={0} max={lookahead} value={shown(settings.activation_cue_window_minutes)}
            onChange={(e) => set({ activation_cue_window_minutes: toNumber(e.target.value) })} />
        </Field>
        <Field settingKey="qr_lifetime_seconds" label={SETTING_LABELS.qr_lifetime_seconds} hint="15–3600. How long a member's walk-up code stays valid; the app fetches a new one as it runs out.">
          <Input type="number" min={15} max={3600} value={shown(settings.qr_lifetime_seconds)}
            onChange={(e) => set({ qr_lifetime_seconds: toNumber(e.target.value) })} />
        </Field>
        <Field
          settingKey="roster_window_minutes"
          label={SETTING_LABELS.roster_window_minutes}
          // "when the API is unreachable" is our word for our server (A9).
          hint={`5–1440. How far ahead a box's cached roster lets it admit booked members when it cannot reach the club's system. ${doorReach}`}
        >
          <Input type="number" min={5} max={1440} value={shown(settings.roster_window_minutes)}
            onChange={(e) => set({ roster_window_minutes: toNumber(e.target.value) })} />
        </Field>
        {/* Here rather than in the Door gates block: the cooldown bounds the "not reporting"
            mail for every board the club has, court boxes included, and filing it with the
            doors would have read as a door setting an admin chasing a noisy box would never
            find. The second clause is a separate rule rather than a consequence of this one,
            and is said here because an admin who does not know it reads a silent unnamed door
            as a cooldown that is too long. */}
        <Field
          settingKey="device_alert_cooldown_minutes"
          label={SETTING_LABELS.device_alert_cooldown_minutes}
          hint={`${DEVICE_ALERT_COOLDOWN_MIN_MINUTES}–${DEVICE_ALERT_COOLDOWN_MAX_MINUTES}. At most one “not reporting” email per board in this many minutes; a door nobody has named never alerts.`}
        >
          <Input type="number" min={DEVICE_ALERT_COOLDOWN_MIN_MINUTES} max={DEVICE_ALERT_COOLDOWN_MAX_MINUTES}
            value={shown(settings.device_alert_cooldown_minutes)}
            onChange={(e) => set({ device_alert_cooldown_minutes: toNumber(e.target.value) })} />
        </Field>
      </div>
    </SettingsSection>
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
  // The copy below quotes this number back at the admin. An emptied box is flagged on the
  // field itself; the sentences fall back to the floor the API clamps to on read, which is
  // what `doorBookingHorizonMinutes` already does with the same value.
  const earlyEntry = orElse(settings.gate_early_entry_minutes, GATE_EARLY_ENTRY_MIN_MINUTES);
  return (
    <SettingsSection id={SECTION_IDS.doors} title="Door gates">
      <p className="text-sm text-text-secondary">
        How the doors behave. A door picks a change up the next time it calls in.{" "}
        {gateOfflineFallbackNotice()}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field
          settingKey="gate_unlock_seconds"
          label={SETTING_LABELS.gate_unlock_seconds}
          hint={`${GATE_UNLOCK_MIN_SECONDS}–${GATE_UNLOCK_MAX_SECONDS}. How long the lock is released each time a door opens. A door never holds it open longer than ${GATE_UNLOCK_MAX_SECONDS} seconds, whatever is set here.`}
        >
          <Input type="number" min={GATE_UNLOCK_MIN_SECONDS} max={GATE_UNLOCK_MAX_SECONDS} value={shown(settings.gate_unlock_seconds)}
            onChange={(e) => set({ gate_unlock_seconds: toNumber(e.target.value) })} />
        </Field>
        <Field
          settingKey="gate_access_policy"
          label={SETTING_LABELS.gate_access_policy}
          hint={describeGatePolicy(settings.gate_access_policy, earlyEntry)}
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
          settingKey="gate_early_entry_minutes"
          label={SETTING_LABELS.gate_early_entry_minutes}
          hint={`${GATE_EARLY_ENTRY_MIN_MINUTES}–${GATE_EARLY_ENTRY_MAX_MINUTES}. ${describeEarlyEntry(settings.gate_access_policy)}`}
        >
          <Input type="number" min={GATE_EARLY_ENTRY_MIN_MINUTES} max={GATE_EARLY_ENTRY_MAX_MINUTES} value={shown(settings.gate_early_entry_minutes)}
            onChange={(e) => set({ gate_early_entry_minutes: toNumber(e.target.value) })} />
        </Field>
      </div>
      {/* The answer itself, rather than three hints and an arithmetic exercise. Three fields on
          two blocks decide it, two of them under a heading that says Court boxes, and under the
          default policy the answer is none of the three — which is exactly how this screen came
          to state a door's early-entry window as 30 while the door's was 130. */}
      <p className="text-sm font-medium text-text-primary">
        {describeDoorBookingHorizon(doorBookingHorizonMinutes(settings))}
      </p>
      {/* C13 — and WHERE that number came from, in a second sentence rather than in the
          first, because the first one was already right and is already pinned. */}
      <p className="text-sm text-text-secondary">{doorHorizonBasis(settings)}</p>
      <DoorRecordsBlock settings={settings} set={set} />
    </SettingsSection>
  );
}

/**
 * Which fields on screen the door horizon above was read from. (C13)
 *
 * <p>
 * <b>The finding.</b> Reviewer C edited "Early entry" and watched the sentence above not
 * move. It was not stale — under <code>active_member</code> the number really is read from
 * two fields on the <em>Court boxes</em> card — but a derived sentence that ignores the
 * control directly beside it, and says nothing about why, reads as a broken page and sends
 * an admin to change the wrong number. The rule lives in
 * {@link doorBookingHorizonBasis}; the words live here, with the captions the fields are
 * actually wearing taken from {@link SETTING_LABELS} rather than written out a second time.
 * </p>
 *
 * <p>
 * The last clause is the other half of C13. Under the open policy a booking QR is not the
 * only way through a door at all — a member's own code works whenever their membership is
 * active — and a block that quotes one horizon and never mentions that reads as the whole
 * rule. Under the strict policy it would be false, so it is not said there.
 * </p>
 */
function doorHorizonBasis(settings: AdminSettings): string {
  const basis = doorBookingHorizonBasis(settings);
  const named = basis.from.map((key) => `“${SETTING_LABELS[key]}”`).join(" plus ");
  const early = `“${SETTING_LABELS.gate_early_entry_minutes}”`;
  const parts: string[] = [];

  if (settings.gate_access_policy === "booking_window") {
    parts.push(
      `Under “${GATE_POLICY_LABELS.booking_window}” that is ${named} on this block and nothing`
      + " else — change it and this sentence changes with it.",
    );
  } else if (basis.floorGoverns) {
    parts.push(
      `Under “${GATE_POLICY_LABELS.active_member}” it comes from ${named} on this block: the two`
      + ` court-box windows below would give ${basis.courtWindowsMinutes}, and a door never opens`
      + " less early than this floor.",
    );
  } else {
    parts.push(
      `Under “${GATE_POLICY_LABELS.active_member}” it comes from ${named} — both on the “Court`
      + ` boxes & identification” block above, not from ${early}, which only sets a floor`
      + ` (currently ${basis.floorMinutes}). Editing ${early} below that changes nothing here.`,
    );
  }

  if (basis.capped) {
    parts.push(`Those two add up to more than ${DOOR_BOOKING_HORIZON_MAX_MINUTES} minutes, which is the cap, so the answer stops there.`);
  }

  if (settings.gate_access_policy === "active_member") {
    parts.push(
      "A booking QR is not the only way in under this policy, either: a member's own code opens a"
      + " door whenever their membership is active, booking or no booking.",
    );
  }

  return parts.join(" ");
}

/**
 * doors: admin — W1's five numbers, behind a divider inside the Door gates card.
 *
 * <p>
 * They are here rather than in a card of their own because they are still about doors, and
 * behind a divider because they are about what the club KEEPS and what it tells a member,
 * rather than about who may open one. Filing them beside "Who may open a door" would put a
 * privacy setting next to an access setting, which is the shape of mistake the two
 * activation windows on the Court boxes block already made once.
 * </p>
 *
 * <p>
 * Every field renders only when the API served the key: an older API leaves it `undefined`,
 * omitted means unchanged on the way back, and an input bound to `undefined` is an
 * uncontrolled field that reports a save of a value nobody typed.
 * </p>
 */
function DoorRecordsBlock({ settings, set }: {
  settings: AdminSettings;
  set: (patch: Partial<AdminSettings>) => void;
}) {
  // Null rather than NaN while the box is empty: the sentence below has a no-number arm
  // already — the one an older API without the key takes — and it is the honest one here too.
  const retentionDays = Number.isFinite(settings.door_log_retention_days)
    ? settings.door_log_retention_days as number
    : null;
  return (
    <div className="border-t border-border pt-4 space-y-4">
      <h3 className="text-sm font-semibold">Door records and contact</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {settings.door_log_retention_days !== undefined && (
          <Field
            settingKey="door_log_retention_days"
            label={SETTING_LABELS.door_log_retention_days}
            hint={`${DOOR_LOG_RETENTION_MIN_DAYS}–${DOOR_LOG_RETENTION_MAX_DAYS}. Past this a door scan is DELETED, receipts and all, rather than anonymised. Money records follow the separate, longer rule above.`}
          >
            <Input type="number" min={DOOR_LOG_RETENTION_MIN_DAYS} max={DOOR_LOG_RETENTION_MAX_DAYS}
              value={shown(settings.door_log_retention_days)}
              onChange={(e) => set({ door_log_retention_days: toNumber(e.target.value) })} />
          </Field>
        )}
        {settings.door_refusal_spike_count !== undefined && (
          <Field
            settingKey="door_refusal_spike_count"
            label={SETTING_LABELS.door_refusal_spike_count}
            hint={`${DOOR_REFUSAL_SPIKE_MIN_COUNT}–${DOOR_REFUSAL_SPIKE_MAX_COUNT}. How many refusals at one door, inside the window beside this, before Doors says the door is refusing a lot. It counts SCANS: one person trying four times is four.`}
          >
            <Input type="number" min={DOOR_REFUSAL_SPIKE_MIN_COUNT} max={DOOR_REFUSAL_SPIKE_MAX_COUNT}
              value={shown(settings.door_refusal_spike_count)}
              onChange={(e) => set({ door_refusal_spike_count: toNumber(e.target.value) })} />
          </Field>
        )}
        {settings.door_refusal_spike_minutes !== undefined && (
          <Field
            settingKey="door_refusal_spike_minutes"
            label={SETTING_LABELS.door_refusal_spike_minutes}
            hint={`${DOOR_REFUSAL_SPIKE_MIN_MINUTES}–${DOOR_REFUSAL_SPIKE_MAX_MINUTES}. The window that count is measured over. It rolls, so the flag clears itself when the window empties and there is nothing to acknowledge.`}
          >
            <Input type="number" min={DOOR_REFUSAL_SPIKE_MIN_MINUTES} max={DOOR_REFUSAL_SPIKE_MAX_MINUTES}
              value={shown(settings.door_refusal_spike_minutes)}
              onChange={(e) => set({ door_refusal_spike_minutes: toNumber(e.target.value) })} />
          </Field>
        )}
        {settings.club_contact_phone !== undefined && (
          <Field
            settingKey="club_contact_phone"
            label={SETTING_LABELS.club_contact_phone}
            hint={`Digits, spaces and + - ( ) , — at most ${CLUB_CONTACT_PHONE_MAX_LENGTH} characters. What a member sees when a door turns them away, and what goes on a printed door card. Leave it empty if the club has none — the screens say so rather than showing a blank.`}
          >
            <Input value={settings.club_contact_phone} maxLength={CLUB_CONTACT_PHONE_MAX_LENGTH}
              inputMode="tel"
              placeholder="076 226 1390"
              onChange={(e) => set({ club_contact_phone: e.target.value })} />
          </Field>
        )}
        {settings.club_contact_email !== undefined && (
          <Field
            settingKey="club_contact_email"
            label={SETTING_LABELS.club_contact_email}
            hint={`At most ${CLUB_CONTACT_EMAIL_MAX_LENGTH} characters. The same, by mail. Also optional — and printed on the same card, so it has to be an address that works.`}
          >
            <Input type="email" value={settings.club_contact_email} maxLength={CLUB_CONTACT_EMAIL_MAX_LENGTH}
              placeholder="squash@example.co.za"
              onChange={(e) => set({ club_contact_email: e.target.value })} />
          </Field>
        )}
      </div>
      {/* The answer itself, in the words the door log prints, so an admin sees what they are
          choosing rather than a number whose consequence they have to go and find. */}
      <p className="text-sm font-medium text-text-primary">
        {doorRetentionNotice(retentionDays)}
      </p>
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
 *
 * <p>
 * <b>And the error rides the same wire.</b> A refused value used to be reported by one
 * sentence at the foot of the whole card and by Save going dead — nothing on the input
 * itself, so a screen reader moving field by field met a form with nothing wrong with it.
 * `aria-describedby` is a LIST, so the message JOINS the hint rather than replacing it: the
 * bound is the context the complaint is read in. (B5)
 * </p>
 */
/**
 * The two per-day caps, in one sentence, because neither field alone says how they compose.
 *
 * <p>
 * Ruling 3: Dean asked for SLOTS, the number already on disk is MINUTES, and both stay — the
 * most restrictive of the two is what a member meets. A club that sets "4 slots" and leaves
 * the minutes at 60 has set an hour and would never learn it from either field.
 * </p>
 *
 * <p>
 * Three arms, and the third is the one that matters while the backend is being built: where
 * the slots key has not shipped, the sentence says what is true — the minutes cap alone —
 * rather than quoting a default this console invented.
 * </p>
 */
function capsSentence(settings: AdminSettings): string {
  const slots = settings.member_max_slots_per_day;
  const minutes = settings.member_per_day_max_minutes;
  const slice = settings.slice_minutes;
  const minutesClause = Number.isFinite(minutes) && minutes > 0
    ? `${minutes} minutes a day`
    : null;
  if (slots === undefined) {
    return minutesClause
      ? `Today a member may hold ${minutesClause}. Admins are not limited.`
      : "Members are not limited by time today, and admins never are.";
  }
  const slotsClause = slots > 0 ? `${slots} slot${slots === 1 ? "" : "s"} a day` : null;
  if (!slotsClause && !minutesClause) return "No per-day limit at all — a member may hold as much as the club is open for.";
  if (!slotsClause) return `Only the time limit applies: ${minutesClause}. Admins are not limited.`;
  if (!minutesClause) return `Only the slot limit applies: ${slotsClause}. Admins are not limited.`;
  const asMinutes = Number.isFinite(slice) && slice > 0 ? slots * slice : null;
  const which = asMinutes === null
    ? "Whichever is stricter is what a member meets."
    : asMinutes <= minutes
      ? `${slotsClause} is ${asMinutes} minutes, so the slot limit is the one a member meets.`
      : `${minutesClause} is stricter than ${slotsClause}, so the time limit is the one a member meets.`;
  return `A member may hold ${slotsClause} and ${minutesClause}. ${which} A group may lower either and may never raise one. Admins are not limited.`;
}

/**
 * A block of the new numeric settings, rendered from {@link NumericSettingRule}s.
 *
 * <p>
 * Rendered from the table rather than written out field by field, deliberately: twelve new
 * numbers written by hand is twelve chances for a field's `min` to disagree with the bound
 * the save is validated against, which is exactly the failure that produces a save refused
 * with a message nobody on the screen can act on.
 * </p>
 *
 * <p>
 * A rule whose key the API does not serve renders NO field. An input bound to `undefined` is
 * an uncontrolled input that React warns about and that silently sends nothing — and a row
 * for a setting the club does not have is a row somebody edits and then cannot save.
 * </p>
 */
function EcoSection({ id, title, lede, rules, settings, onChange, children }: {
  id: string;
  title: string;
  lede: string;
  rules: readonly NumericSettingRule[];
  settings: AdminSettings;
  onChange: (next: AdminSettings) => void;
  children?: React.ReactNode;
}) {
  const held = settings as unknown as Record<string, unknown>;
  const present = rules.filter((rule) => held[rule.key] !== undefined);
  return (
    <SettingsSection id={id} title={title}>
      <p className="text-sm text-text-secondary">{lede}</p>
      {present.length === 0 && (
        /* Both halves: the club's system has not got these yet, and that is not the same as
           the club having turned them off. */
        <p className="text-sm text-text-muted">
          The club&rsquo;s system is not serving these settings yet, so there is nothing to change here.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {present.map((rule) => (
          <Field key={rule.key} settingKey={rule.key} label={rule.label} hint={rule.hint}>
            <Input
              type="number"
              min={rule.min}
              max={rule.max}
              value={shown(held[rule.key] as number)}
              onChange={(e) => onChange({ ...settings, [rule.key]: toNumber(e.target.value) })}
            />
          </Field>
        ))}
      </div>
      {children}
    </SettingsSection>
  );
}

function Field({ label, hint, settingKey, children }: {
  label: string;
  hint?: string;
  /** The settings key this field edits, which gives it an anchor and an error to show. */
  settingKey?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const { errors, highlighted } = useContext(FieldStateContext);
  const anchorId = settingKey ? settingAnchorId(settingKey) : undefined;
  const error = settingKey ? errors[settingKey] : undefined;
  /**
   * C12 — the complaint, said out loud, when the person leaves the field.
   *
   * <p>
   * The message has been on the input's <code>aria-describedby</code> since B5, which is
   * what a screen reader reads when it ARRIVES at the field. It reads nothing when the value
   * inside it goes bad, because a description is not a live region — so an admin typing 400
   * into a field bounded at 30 and tabbing on was told nothing at all until they reached
   * Save, thirty fields later. Announcing on blur rather than on every keystroke is the
   * difference between a field that reports a finished answer and one that interrupts a
   * half-typed one.
   * </p>
   *
   * <p>
   * Derived rather than stored: the flag says "this field has been left", and the text is
   * whatever is wrong with it NOW. A message cannot outlive the mistake it is about.
   * </p>
   */
  const [left, setLeft] = useState(false);

  // The error first: it is the news. A field with both reads "…is out of range. 1–30, how
  // long the lock is released…", which is the order a person would want it in.
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");
  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<{
        id?: string; className?: string; "aria-describedby"?: string; "aria-invalid"?: boolean;
      }>, {
        id,
        // C12 — a boundary that says something is wrong with it, rather than the same border
        // every other field on the page is wearing. `aria-invalid` alone was the whole marking:
        // measured, a refused field and a good one were pixel-identical.
        className: cn(
          (children as React.ReactElement<{ className?: string }>).props.className,
          error && "border-danger-strong ring-1 ring-danger-strong",
        ),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(error ? { "aria-invalid": true } : {}),
      })
    : children;

  return (
    <div
      id={anchorId}
      data-invalid={error ? "" : undefined}
      onFocus={() => setLeft(false)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLeft(true); }}
      className={`scroll-mt-24 ${anchorId && highlighted === anchorId ? HIGHLIGHT_CLASS : ""}`}
    >
      <Label htmlFor={id}>{label}</Label>
      {control}
      {error && (
        <p id={errorId} className="text-xs text-danger-strong mt-1 flex items-start gap-1">
          {/* The icon is the half a colour cannot carry: danger red on white is a colour, and
              colour alone is never the signal (SC 1.4.1). `aria-hidden` because the sentence
              beside it already says everything the shape does. */}
          <AlertCircle size={14} strokeWidth={2.5} aria-hidden="true" className="mt-px shrink-0" />
          <span>{error}</span>
        </p>
      )}
      {hint && <p id={hintId} className="text-xs text-text-muted mt-1">{hint}</p>}
      <p aria-live="polite" className="sr-only">{left && error ? `${label}: ${error}` : ""}</p>
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
    <SettingsSection
      id={SECTION_IDS.courts}
      title="Courts"
      className="space-y-4"
      beside={<span className="text-xs text-text-muted">{courts.filter((c) => c.is_active).length} active · {courts.length} total</span>}
    >
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
    </SettingsSection>
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
          /*
            No `className`. It was `h-11 px-4`, and neither half was doing what it looked like.
            `h-11` is stripped by the component (`withoutFixedHeight`) because a height is not a
            floor and a control shorter than its own words is the defect that rule closes. And
            `px-4` is 1 rem a side — 32 px each at a 32 px root font size, 64 px of padding
            inside a control this row gives 140 px to, leaving 76 px for the word "Deactivate".
            The component's own `px-[12px]` is in pixels for exactly that reason; overriding it
            with a rem put the padding back on the scale the padding was taken off.
          */
        />
      ) : (
        <span className="text-xs text-text-muted px-3">Inactive</span>
      )}
    </div>
  );
}
