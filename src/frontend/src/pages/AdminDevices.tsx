import { useCallback, useEffect, useRef, useState } from "react";
import {
  endpoints, isGate, type AdminCourt, type AdminDevice, type AdminSettings, type DeviceActivityEntry,
} from "../lib/api";
import { isOnline, offlineAfterSecondsFor, relative } from "../lib/deviceLiveness";
import { useTicker } from "../lib/useTicker";
import { OFFLINE_WHO_NOTE, doorDisplayName, doorStateChip } from "../lib/doorsCopy";
import { describeDeviceError } from "../lib/deviceErrors";
import { unsureSentence, writeOrReadBack } from "../lib/lostReply";
import { LOST_REPLY, unsureWords } from "../lib/lostReplyCopy";
import {
  ACTIVITY_READ_FAILED, activityEmptyNotice, activityPanelTitle, describeActivityAction,
  describeActivityReason, describeActivityWho, unacknowledgedBoardsNotice,
} from "../lib/deviceActivity";
// R3 adoption: the club's clock, not the reader's. The `lib/utils` formatter this replaced
// renders through `toLocaleString(undefined, …)`, so this feed read "9/19/26, 9:25 PM" on an
// admin laptop set to en-US while every other time on the doors surface read
// "19 September 2026, 21:25". Two formats on one estate is what makes reconciling a night
// after an incident guesswork. `pages/AdminDevices.tsx` is on `clubClock.test.ts`'s SURFACES
// list from the same commit, so the old formatter cannot come back unnoticed.
import { clubInstant } from "../lib/clubClock";
import {
  coverageWithout, outOfServiceConfirm, outOfServiceConsequences, type CourtCoverage,
} from "../lib/deviceCoverage";
import { UNNAMED_GATE, describeGate } from "../lib/gateCopy";
import { ActionsMenu } from "../components/admin/ActionsMenu";
import { ConfirmDialog } from "../components/admin/ConfirmDialog";
import { chipTone } from "../components/doors/chipTone";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { RadioCard, RadioGroup } from "../components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ButtonMapEditor } from "../components/ButtonMapEditor";
import { buttonMapWithinCap, MAX_GRANT_MINUTES, RELAYS } from "../lib/buttonMap";
import { ClubButtonMapCard, WalkUpCapNotice } from "../components/ClubButtonMapCard";
import { DeviceApiKeyPanel } from "../components/DeviceApiKeyPanel";
import { BoardScreen, BoardScreenEditor, BoardStatusLines } from "../components/devices/BoardV3";
import {
  BoardHardwareEditor, BoardHardwareSummary, BoardHealth, CommissioningChecklist, type HwPatch,
} from "../components/devices/BoardHardware";
import { servesHardware } from "../lib/deviceHardware";
import { describeRelayCourts as describeCourts } from "../lib/deviceV3Copy";
import { useBoardsContext } from "../components/devices/useBoardsContext";
import { RemoteFixes } from "../components/devices/RemoteFixes";
import type { BoardsContext } from "../lib/boardScreen";
import { useToast } from "../components/toastContext";
import { PageHeader, PageShell, Section } from "../components/ui/page-shell";
import { AutoGrid } from "../components/ui/auto-grid";
import { Freshness, RefreshButton } from "../components/ui/refresh-button";
import { StateBlock } from "../components/ui/state-block";
import { Skeleton } from "../components/ui/skeleton";
import { TextLink } from "../components/ui/text-link";
import { CaretDown, Cpu, Door, Trash, WifiHigh, WifiSlash } from "../components/ui/icons";
import { CardListSkeleton } from "../components/monitoring/parts";
import { useInlineEditorFocus } from "../components/admin/useInlineEditorFocus";

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
 * How often the page re-reads the boards, milliseconds.
 *
 * <p>
 * This screen's entire content is liveness — "online" / "last seen Nm ago" — and the
 * peripheral-health email tells an admin to open it and watch a box recover. It loaded once
 * on mount and never again, so the page the alert LINKS TO showed the state at the moment
 * it was opened: a tab left open read "online" for a box six and a half minutes dark, more
 * than double the offline threshold and long after the club had been emailed about it
 * (finding M-F2).
 * </p>
 *
 * <p>
 * Fifteen seconds is the firmware's own minimum heartbeat interval, so the page cannot be
 * more than one beat behind the fastest box a club can configure. Only the device list is
 * re-read; the settings and courts behind it change when an admin changes them.
 * </p>
 */
const REFRESH_MS = 15_000;


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
  // Firmware, the Mega and the v3 state are their own lines (BoardStatusLines): one muted run
  // of versions told nobody which board missed the last flash (FA-12).
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
      <p className="text-sm text-warning-strong">
        No courts to assign yet. Add the club's courts under Courts first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {RELAYS.map((relay, index) => {
        const current = value[index];
        const reachable = !disabled && index <= value.length;
        const label = `${labelPrefix ? `${labelPrefix} relay` : "Relay"} ${relay} court`;
        return (
          <div key={relay} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-sm font-medium text-text-secondary">Relay {relay}</span>
            {/* Radix Select has no empty value, so "no court" is the NONE sentinel here and
                nowhere else — it never reaches the wire. */}
            <Select
              value={current === undefined ? NONE : String(current)}
              disabled={!reachable}
              onValueChange={(next) => {
                if (next === NONE) onChange(value.slice(0, index));
                else onChange([...value.slice(0, index), Number(next), ...value.slice(index + 1)]);
              }}
            >
              <SelectTrigger aria-label={label} className="min-w-0 max-w-xs flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{index === 0 ? "Choose a court" : "— none —"}</SelectItem>
                {courts.map((court) => (
                  <SelectItem
                    key={court.id}
                    value={String(court.court_number)}
                    disabled={value.includes(court.court_number) && current !== court.court_number}
                  >
                    {`Court ${court.court_number} — ${court.name}${court.is_active ? "" : " (inactive)"}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Worded buttons on this page wrap rather than overflow: at a 32 px root font on a 320 px
 * phone "Edit name and courts" is wider than the card, and the design-system Button is
 * `whitespace-nowrap` by default (e2e/admin-devices "refuses to hold its own content").
 */
const WRAPS = "h-auto min-h-9 max-w-full grow whitespace-normal px-1.5 py-1.5 text-center";

/** "No court on this relay" inside the Select — see CourtListEditor. */
const NONE = "none";

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
    // R11 L11-3: the panel's inset steps down with the board's box (`@container/boardslot`), never
    // the viewport — at 320 / 200 % a 2rem card inset plus this 2rem one left the map 90px.
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-muted p-2 @[16rem]/boardslot:p-4">
      <RadioGroup
        value={own ? "own" : "club"}
        onValueChange={(next) => setOwn(next === "own")}
        disabled={saving}
        aria-label={`${device.name} buttons`}
        className="grid gap-2 sm:grid-cols-2"
        name={group}
      >
        <RadioCard value="club" title="Use the club's button map" />
        <RadioCard value="own" title="Own map for this box" />
      </RadioGroup>
      {own && <ButtonMapEditor value={draft} onChange={setDraft} disabled={saving} labelPrefix={device.name} />}
      <WalkUpCapNotice map={own ? draft : clubMap} cap={walkUpMax} />
      <div className="flex flex-wrap gap-2">
        <Button pending={saving} onClick={() => void save()} disabled={own && !buttonMapWithinCap(draft)}>
          Save buttons
        </Button>
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

// --- one board in the list --------------------------------------------------

/** Everything a row can ask the page to do to its device. */
type DeviceActions = {
  details: (name: string, courtNumbers: number[]) => Promise<boolean>;
  buttonMap: (map: string[] | null) => Promise<boolean>;
  /** v3: the board's own layout and marquee, or null for the club's (three-valued, like the map). */
  screen: (layout: string | null, marquee: boolean | null) => Promise<boolean>;
  /** v3 §8: send the club's network to a board set up at its own portal. */
  pushNetwork: () => Promise<boolean>;
  /** v3 §12: this board's hardware facts, three-valued per key. */
  hardware: (patch: HwPatch) => Promise<boolean>;
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
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-muted p-4">
      <Field controlId={nameId} className="max-w-sm">
        <FieldLabel>Name</FieldLabel>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Court 1 box" disabled={saving} />
      </Field>
      <div role="group" aria-labelledby={`${nameId}-courts`} className="flex flex-col gap-2">
        <span id={`${nameId}-courts`} className="text-sm font-medium text-text-primary">Courts, by relay</span>
        <FieldDescription>
          Relay A is the first output on the box. Assign the courts in the order they are wired.
        </FieldDescription>
        <CourtListEditor value={draft} onChange={setDraft} courts={courts} disabled={saving} labelPrefix={device.name} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button pending={saving} onClick={() => void save()} disabled={draft.length === 0}>Save box</Button>
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

/** The badges and the identity line — everything about a row that is read-only. */
function DeviceRowHeader({ device, online, now, context }: {
  device: AdminDevice; online: boolean; now: number; context: BoardsContext;
}) {
  // Presence-gated: an API that does not send the field cannot have an override.
  const hasOwnMapField = device.button_map !== undefined;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {device.enabled && online
          ? <WifiHigh size={16} weight="bold" className="shrink-0 text-success-strong" aria-label="online" />
          : <WifiSlash size={16} weight="bold" className="shrink-0 text-text-muted" aria-label={device.enabled ? "offline" : "out of service"} />}
        {/* min-w-0 so a long name gives way inside the flex row instead of setting its
            width; break-words so it wraps rather than running off the card. */}
        <span className="min-w-0 break-words font-medium">{device.name}</span>
        {/* A box an admin switched off is not "offline" — nobody expects it to call in,
            and showing it beside the boxes that have genuinely gone quiet is how a club
            learns to ignore the state that matters. Silence is loud, though: a box that
            has gone quiet on its own gets the danger tone, not the neutral grey it had
            while a louder amber "New" badge sat next to it (M-F2, secondary). */}
        {!device.enabled
          ? <Badge tone="neutral">out of service</Badge>
          : (
            <Badge tone={online ? "success" : "danger"}>
              {online ? "online" : `not reporting — last seen ${relative(device.last_seen_at, now)}`}
            </Badge>
          )}
        {/* A box registers itself with a generated name and default courts. Until an
            admin has looked, the club has a live box whose relays probably point at the
            wrong courts — which is a league night with the wrong lights on, not a
            cosmetic gap. The badge clears when the row is edited.

            A DOOR's equivalent badge is not here any more (A2.5): a doors-first page keys
            the job on the missing NAME rather than on the new-board flag, because a door
            that was named months ago and never edited is fine and one whose name somebody
            cleared is not. See doorSetupChip in lib/doorsCopy. */}
        {device.auto_registered && <Badge tone="warning">New — check court numbers</Badge>}
        {hasOwnMapField && device.button_map != null && <Badge tone="info">own button map</Badge>}
      </div>

      {/* break-words, because a gate key may be 64 characters of somebody's own naming
          scheme with no space in it, and this line already carries a device code, a MAC and
          two version strings. The row used to push the page wider than the phone on a long
          device NAME alone (R2 I-F6); an unbreakable 64-character token is the same defect
          with a larger token. */}
      <div className="mt-1 break-words text-xs text-text-muted">{identityLine(device)}</div>
      <BoardStatusLines device={device} context={context} />
    </>
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
 * <b>A GATE never reaches this notice at all (A2.5).</b> A door drives no courts, so every
 * clause above about a court going dark and its no-shows being waived is simply not true of
 * one — and rather than a second branch here, a door is shut on /admin/monitoring/doors, where
 * `doorStateNotice` says the door's own consequence. Two call sites for one 403 path is the
 * failure `lib/gateCopy.ts`'s header documents.
 * </p>
 */
function OutOfServiceNotice({ device, coverage }: { device: AdminDevice; coverage: CourtCoverage }) {
  return (
    <p className="rounded-lg bg-bg-muted p-3 text-sm text-text-secondary">
      {`Out of service. The API refuses this box, so it switches nothing on, and the club is not`
        + ` alerted about its silence. ${outOfServiceConsequences(coverage).join(" ")}`}
      <span className="sr-only">{device.name}</span>
    </p>
  );
}

// --- a board's own trail ---------------------------------------------------------

/**
 * One row of the trail: what happened, to whom, why, and when.
 *
 * <p>
 * Its own component rather than a `map` body inside the panel, because the panel is
 * already a loader with four states and the complexity gate holds this file at its bound.
 * </p>
 *
 * <p>
 * Two lines, not four columns. Fifty rows of four columns on a phone is four columns of
 * two characters each; the decision goes on the first line with its age, and who and why
 * share the second. A row with neither — a boot — renders one line rather than an empty
 * second one.
 * </p>
 *
 * <p>
 * `title` on the action carries the raw token. The words are for reading; the token is for
 * whoever has to report a new action upstream, and losing it would make a humanised
 * unknown unsearchable.
 * </p>
 */
function ActivityRow({ entry, now }: { entry: DeviceActivityEntry; now: number }) {
  const who = describeActivityWho(entry);
  const why = describeActivityReason(entry);
  const detail = [who, why].filter((part) => part !== null).join(" · ");
  return (
    <li className="border-t border-border py-1.5 first:border-t-0">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 break-words font-medium text-text-primary" title={entry.action}>
          {describeActivityAction(entry)}
        </span>
        {/* Relative for the glance, exact on hover or long-press for the reconciliation —
            the pair the liveness line above and the ledger both already use. */}
        <time dateTime={entry.at} title={clubInstant(entry.at)} className="ml-auto shrink-0 text-text-muted">
          {relative(entry.at, now)}
        </time>
      </div>
      {/* min-w-0 AND break-words: a member's display name is the one arbitrarily wide
          thing in this panel, and a row that sets its own width pushes the whole page
          wider than the phone (R2 I-F6) — fifty times over, here. */}
      {detail && <div className="mt-0.5 min-w-0 break-words text-text-muted">{detail}</div>}
    </li>
  );
}

/** What the panel is showing right now, once the four states are collapsed into one read. */
function ActivityBody({ entries, loading, error, gate, now }: {
  entries: DeviceActivityEntry[] | null;
  loading: boolean;
  error: string | null;
  gate: boolean;
  now: number;
}) {
  if (loading) {
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <p role="status" className="sr-only">Reading the trail…</p>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  // Before empty, deliberately. A failed read that rendered "nothing recorded yet" would
  // be making a claim about the DOOR ("nobody has been through it") out of a claim about
  // the request, which is how an admin concludes a working door is dead.
  if (error) return <p className="text-sm text-danger-strong">{error}</p>;
  if (!entries || entries.length === 0) return <p className="text-sm text-text-muted">{activityEmptyNotice(gate)}</p>;
  return (
    <>
      {/* A3, on the panel it was missed on. A reviewer read nine offline rows — some naming
          a member, some not — with nothing reconciling the two, and concluded records had
          been lost. They had not: an offline board decides from the list it last
          downloaded, so a code ON that list resolves to its holder and one that is not
          resolves to nobody. Said once, where the offline rows are, rather than left to be
          inferred; the doors surface has carried this since the finding landed and this
          panel serves the same rows for a court box. */}
      {entries.some((entry) => entry.offline) && (
        <p className="mb-1 text-sm text-text-secondary">{OFFLINE_WHO_NOTE}</p>
      )}
      <ul className="text-sm">
        {entries.map((entry, i) => <ActivityRow key={`${entry.at}-${entry.action}-${i}`} entry={entry} now={now} />)}
      </ul>
    </>
  );
}

/**
 * A board's own trail, collapsed until an admin asks for it.
 *
 * <p>
 * <b>Why this screen at all.</b> The door has written an audit row for every scan since it
 * shipped and nothing read one, so "why was I turned away at the front door last night"
 * had a database query as its only answer — and the seven refusal reasons had travelled
 * through the firmware, the wire corpus and the spec for three rounds without ever becoming
 * a sentence anybody could read.
 * </p>
 *
 * <p>
 * <b>Shut by default and fetched on open.</b> A club with eight boards would otherwise make
 * eight extra calls on every load of a page that already re-reads itself every fifteen
 * seconds, for panels nobody opened. Re-fetched on every open rather than cached, because
 * the trail is the one thing on this row that a member standing at the door changes while
 * the admin is looking at it.
 * </p>
 *
 * <p>
 * No `mounted` ref and no cleanup guard: this is event-driven, not effect-driven, so
 * StrictMode's mount → cleanup → mount cannot leave a ref false before the first click —
 * the shape that has produced two defects in this repo.
 * </p>
 *
 * <p>
 * The label does not change with the state; `aria-expanded` carries it. A control whose
 * accessible name flips between "Door activity" and "Hide door activity" is a control a
 * screen-reader user has to re-find after every press.
 * </p>
 */
/**
 * A board's own trail, read on demand. The toggle and the panel are drawn apart (R5 §3.16) — the
 * toggle joins the row's action strip and the panel opens under it, which took a 56px line off
 * every board on a phone (234 → 186px; 17,031px for the review club's boards at 390). So the read
 * is a hook, and the two halves are components that take what it holds.
 */
function useDeviceActivity(device: AdminDevice) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DeviceActivityEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      setEntries((await endpoints.adminDeviceActivity(device.id)).items);
    } catch (e) {
      setError(describeDeviceError(e, ACTIVITY_READ_FAILED));
      setEntries(null);
    } finally {
      setLoading(false);
    }
  }

  return { open, entries, loading, error, toggle };
}

type DeviceActivity = ReturnType<typeof useDeviceActivity>;

function ActivityToggle({ device, activity }: { device: AdminDevice; activity: DeviceActivity }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={WRAPS}
      aria-expanded={activity.open}
      onClick={() => void activity.toggle()}
      icon={<CaretDown aria-hidden="true" className={activity.open ? "rotate-180" : undefined} />}
    >
      {activityPanelTitle(isGate(device))}
    </Button>
  );
}

function ActivityPanel({ device, activity, now }: { device: AdminDevice; activity: DeviceActivity; now: number }) {
  if (!activity.open) return null;
  return (
    <div className="rounded-lg border border-border bg-bg-muted p-3">
      <ActivityBody entries={activity.entries} loading={activity.loading} error={activity.error} gate={isGate(device)} now={now} />
    </div>
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

/**
 * When this board counts as deaf, and the instant that is judged against.
 *
 * One prop rather than two because they are one question, and because seven flat props put
 * `DeviceRow` over the complexity gate's parameter bound the moment a ticking clock arrived.
 */
type Liveness = { offlineAfter: number; now: number };

/**
 * The id of the control that REPLACES "Take out of service" once it has run. (R3 adoption)
 *
 * <p>
 * `ConfirmButton.focusAfter` is called repeatedly for about a second after the action
 * settles, precisely so it can name a control the re-render has not produced yet — so a
 * stable id is all it needs, and a ref would have to be threaded through two components
 * that do not otherwise know about each other. Derived from the device id rather than the
 * name, because two boxes called "Court box" is a club's own business.
 * </p>
 */
function backInServiceId(deviceId: string): string {
  return `device-${deviceId}-back-in-service`;
}

function DeviceRow({
  device, boxEditing, actions, liveness, coverage, context,
}: {
  device: AdminDevice;
  boxEditing: BoxEditing;
  /** What the page read beside the list, for the v3 lines (device-api §10). */
  context: BoardsContext;
  actions: DeviceActions;
  liveness: Liveness;
  /** What each of this box's courts would be left with without it. See lib/deviceCoverage. */
  coverage: CourtCoverage;
}) {
  const { now } = liveness;
  const online = isOnline(device, liveness.offlineAfter, now);
  const [editing, setEditing] = useState<"details" | "buttons" | "screen" | "hardware" | null>(null);
  const [compacting, setCompacting] = useState(false);
  // R8 X8-3: the editor takes focus when it opens and gives it back to its Edit button on close.
  const card = useRef<HTMLDivElement>(null);
  const editorRegion = useInlineEditorFocus(editing, (was) => card.current?.querySelector<HTMLElement>(`[data-opens-editor="${was}"]`));
  // Presence-gated: an API that does not send the field gets no editor for it.
  const hasOwnMapField = device.button_map !== undefined;
  const activity = useDeviceActivity(device);

  return (
    // R11 L11-3: the grid cell is the query container so the card's own inset can step down by its
    // box in rem (a phone at 200 % text) — a card cannot query itself.
    <div className="@container/boardslot min-w-0">
    <div ref={card} data-board-card="" className="flex flex-col gap-2 rounded-xl border border-border bg-bg-surface p-2 shadow-xs sm:gap-3 @[16rem]/boardslot:p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1"><DeviceRowHeader device={device} online={online} now={now} context={context} /></div>
        {/* Deleting is not a revocation and locks nothing out — the box still holds the
            club's key. It forgets the row, and the box makes a new one on its next call.
            The dialog says exactly that, because "Really delete?" would let an admin think
            they had just taken a box off the network. It lives behind ⋯ (P3): it is the rare
            action, and it must not sit beside Edit at thumb distance. */}
        <ActionsMenu
          label={`More actions for ${device.name}`}
          items={[{
            label: "Delete board",
            icon: <Trash size={16} aria-hidden="true" />,
            danger: true,
            confirm: {
              title: `Delete ${device.name}?`,
              description: "The box re-registers on its next heartbeat — deleting forgets this row, it does not take the box off the network. Unplug it if you mean to retire it.",
              confirmLabel: "Delete board",
              cancelLabel: "Keep this box",
              onConfirm: actions.remove,
            },
          }]}
        />
      </div>

      <div ref={editorRegion} className="contents">
        {editing === "details" && (
          <DeviceDetailsEditor device={device} courts={boxEditing.courts} onSave={actions.details} onClose={() => setEditing(null)} />
        )}

        {editing === "buttons" && (
          <DeviceButtonMapPanel
            device={device}
            clubMap={boxEditing.clubMap}
            walkUpMax={boxEditing.walkUpMax}
            onSave={actions.buttonMap}
            onClose={() => setEditing(null)}
          />
        )}

        {editing === "screen" && (
          <BoardScreenEditor device={device} club={context.club} onSave={actions.screen} onClose={() => setEditing(null)} />
        )}

        {editing === "hardware" && (
          <BoardHardwareEditor device={device} settings={context.settings} onSave={actions.hardware} onClose={() => setEditing(null)} />
        )}
      </div>

      {editing !== "hardware" && <BoardHardwareSummary device={device} settings={context.settings} />}
      <BoardHealth device={device} rises={context.risesOf(device)} />
      {servesHardware(device) && <CommissioningChecklist device={device} />}

      {editing !== "screen" && (
        <BoardScreen
          device={device} context={context} busy={compacting}
          onBackToCompact={() => {
            setCompacting(true);
            // One press, always one heartbeat from taking effect (device-api §5).
            void actions.screen("compact", device.lcd_marquee_enabled ?? null).finally(() => setCompacting(false));
          }}
        />
      )}

      {!device.enabled && <OutOfServiceNotice device={device} coverage={coverage} />}

      {/* The action strip: 44px targets, sm buttons with the extended hit area. Each button grows to
          fill its row, so a row ends flush on the card's edge instead of ragged. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {editing === null && (
          <Button variant="outline" size="sm" className={WRAPS} data-opens-editor="details" onClick={() => setEditing("details")}>Edit name and courts</Button>
        )}

        {hasOwnMapField && editing === null && (
          <Button variant="outline" size="sm" className={WRAPS} data-opens-editor="buttons" onClick={() => setEditing("buttons")}>Edit buttons</Button>
        )}

        {device.lcd_layout !== undefined && editing === null && (
          <Button variant="outline" size="sm" className={WRAPS} data-opens-editor="screen" onClick={() => setEditing("screen")}>Edit screen</Button>
        )}

        {servesHardware(device) && editing === null && (
          <Button variant="outline" size="sm" className={WRAPS} data-opens-editor="hardware" onClick={() => setEditing("hardware")}>Edit hardware</Button>
        )}

        {/* A board set up at its own portal keeps that network until an admin pushes the club's (§8). */}
        {device.net_src === "local" && editing === null && (
          <ConfirmDialog
            trigger={<Button variant="outline" size="sm" className={WRAPS}>Send it the club network</Button>}
            title={`Send ${device.name} the club's network?`}
            description={"It was set up at the box itself and keeps that WiFi and server address until you send it the club's. "
              + "It tries the club's the next time it calls in, and goes back to its own if it cannot reach the club with it."}
            confirmLabel="Send the club network"
            cancelLabel="Leave it as it is"
            tone="primary"
            onConfirm={actions.pushNetwork}
          />
        )}

        {/* Out of service — the control the API, the health sweep and the settlement model
            were all written around and that no screen offered (finding M-F3). Without it a
            box that is broken or has been unplugged for good stays enabled for ever, so the
            club is alerted about a silence it created, and — because a court is "dark" only
            when every ENABLED box driving it is dark — every no-show on that box's courts is
            refunded with no penalty, indefinitely.

            Confirmed on the way out (a dialog naming the consequence per court, from
            outOfServiceConfirm in lib/deviceCoverage), because a live box stops working;
            plain on the way back, because restoring a box is not a decision anyone regrets.
            Focus lands on the control that replaces this one, which is the only thing on the
            row that can tell the reader the action landed.

            A DOOR is not offered this control at all (A2.5): doors are shut on
            /admin/monitoring/doors. */}
        {device.enabled ? (
          <ConfirmDialog
            trigger={<Button variant="outline" size="sm" className={WRAPS}>Take out of service</Button>}
            title={`Take ${device.name} out of service?`}
            // The title asks the question, so the sentence drops its own "Out of service?" lead-in.
            description={outOfServiceConfirm(coverage).replace(/^Out of service\? /, "")}
            confirmLabel="Take out of service"
            cancelLabel="Leave it in service"
            onConfirm={() => actions.setEnabled(false)}
            focusAfter={() => document.getElementById(backInServiceId(device.id))}
          />
        ) : (
          <Button id={backInServiceId(device.id)} variant="secondary" size="sm" className={WRAPS} onClick={() => void actions.setEnabled(true)}>
            Put back in service
          </Button>
        )}

        {/* Last in the strip: the one control on this row that reads rather than writes. Its panel
            opens under the strip. */}
        <ActivityToggle device={device} activity={activity} />
      </div>

      <ActivityPanel device={device} activity={activity} now={now} />
    </div>
    </div>
  );
}

/**
 * The club's doors, read-only, under their own heading (A2.5 / D5).
 *
 * <p>
 * <b>Visible here, edited only on Doors.</b> W1.1 says court boxes stay on this page and
 * gates appear on both, which is right about VISIBILITY and wrong about control: if
 * `GateDetailsEditor`, the gate branch of the out-of-service notice and the gate delete
 * confirm have two call sites, this repo has already documented what happens next —
 * `lib/gateCopy.ts` exists because the court-box consequence "was written three times at
 * three call sites and shipped three rounds running with the three of them disagreeing about
 * what the click had just done". Two screens is two call sites.
 * </p>
 *
 * <p>
 * So a door is one line here: its liveness, its door name, a ticking age and a link. Nothing
 * on this page edits, names, shuts, reopens or deletes a door.
 * </p>
 */
function GateRows({ gates, tenantHeartbeat, now }: {
  gates: AdminDevice[];
  tenantHeartbeat: number | null;
  now: number;
}) {
  if (gates.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center gap-2">
        <Door size={16} className="text-text-muted" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Doors</h3>
      </div>
      <ul className="space-y-2">
        {gates.map((gate) => {
          const online = isOnline(gate, offlineAfterSecondsFor(gate, tenantHeartbeat), now);
          const chip = doorStateChip(gate, online);
          // A11: "Door gate" is the placeholder every self-registering gate arrives with,
          // and the doors surface stopped presenting it as a name — five boards in that
          // state all read "Door gate" and named none of them. This row links straight to
          // that surface, so it cannot call the same board something else.
          const name = doorDisplayName(gate);
          return (
            <li key={gate.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg-surface px-4 py-2.5 shadow-xs">
              {/* A8: `doorStateChip` answers null where the caller cannot say whether a
                  door is reporting. This page always can — it resolves `online` from a read
                  it has just made — so the chip is always here; the guard is the type
                  saying so rather than a claim this call site is allowed to make. */}
              {chip && <Badge tone={chipTone(chip.tone)}>{chip.label}</Badge>}
              <span className="min-w-0 break-words text-sm font-medium">{name}</span>
              <span className="min-w-0 break-words text-xs text-text-muted">
                {`${gate.gate_key ?? UNNAMED_GATE} · ${gate.device_code}`}
              </span>
              <time
                dateTime={gate.last_seen_at ?? undefined}
                aria-live="off"
                className="text-xs text-text-muted"
              >
                {relative(gate.last_seen_at, now)}
              </time>
              {/* R10: navigation is a LINK that looks like one — it was a bordered box posing
                  as a button. TextLink's label is its own shrinkable box, so the words still
                  wrap on a narrow row. */}
              <TextLink
                variant="standalone"
                to={`/admin/monitoring/doors/${gate.id}`}
                className="ml-auto min-w-0 max-w-full text-sm"
                /* The door's NAME in the accessible name. Reviewer B met three links reading
                   "Manage on Doors" on one screen — identical to anybody tabbing or using
                   speech control, and distinguished only by which row they happen to sit in,
                   which is visual position and therefore nothing at all. */
                aria-label={`Manage ${name} on Doors`}
              >
                Manage on Doors
              </TextLink>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-text-muted">Doors are set up and shut under Doors.</p>
    </div>
  );
}

// --- the page ---------------------------------------------------------------

/**
 * What the toast says after the out-of-service switch is thrown, either way.
 *
 * <p>
 * The out-of-service half is the SAME generator the row notice above renders — for a box
 * {@link outOfServiceConsequences}, for a gate {@link doorShutNotice} — because
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
  return `${device.name} deleted. It still has the club's key, so it re-registers on its next heartbeat as a new box — unplug it if you meant to retire it.`;
}

/**
 * The warning that the club is running out of room for new boards.
 *
 * <p>
 * <b>It is here because the refusal is not reachable from this console at all.</b>
 * Auto-registration refuses a new MAC once the tenant holds sixteen rows nobody has
 * acknowledged, and it refuses the BOARD — a 409 `too_many_unacknowledged_devices`
 * answered on the board's own heartbeat, to a piece of firmware with one LED. An admin who
 * flashes a new board and watches it never appear on this list has no error to read
 * anywhere: the screen simply does not grow a row. A warning BEFORE the club gets there is
 * the only form this can take on a screen.
 * </p>
 *
 * <p>
 * Counted on `auto_registered` rather than on how many boards there are. A club with
 * twenty boards an admin has already named is in no danger, and warning it would teach the
 * club to ignore the notice in the state that matters.
 * </p>
 */
function UnacknowledgedBoardsNotice({ devices }: { devices: AdminDevice[] }) {
  const notice = unacknowledgedBoardsNotice(devices.filter((d) => d.auto_registered).length);
  if (notice === null) return null;
  return <p role="status" className="rounded-lg bg-warning-soft p-3 text-sm text-warning-strong">{notice}</p>;
}

/**
 * The mutations a row can ask for, built per device. Kept out of the page component
 * so the page stays a loader and a layout.
 */
function useDeviceActions(reload: () => Promise<void>) {
  const toast = useToast();

  /**
   * One write, read back from the board list when its reply is lost (R4 carry-over): the row as
   * asked → the success sentence with the reply-lost note; read and not → nothing changed;
   * unreadable → not known. A refusal is the club's answer and is said as before.
   */
  const write = async (
    id: string, send: () => Promise<unknown>, holds: (row: AdminDevice | undefined) => boolean,
    words: { done: string; failed: string; still: string; whether: string },
  ): Promise<boolean> => {
    try {
      const { proven, answered } = await writeOrReadBack(
        async () => { await send(); return {}; },
        async () => (holds((await endpoints.adminDevicesList()).find((d) => d.id === id)) ? {} : null),
      );
      toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(words.done, answered) : words.done, durationMs: 8000 });
      await reload();
      return true;
    } catch (e) {
      const unsure = unsureSentence(e, unsureWords(words.still, words.whether, "Boards"));
      if (unsure) void reload().catch(() => undefined);
      toast.push({ tone: "danger", text: unsure ?? describeDeviceError(e, words.failed), durationMs: 8000 });
      return false;
    }
  };

  return (device: AdminDevice, coverage: CourtCoverage): DeviceActions => {
    const named = device.name;
    return {
      /** Returns whether the save went through, so the row knows whether to leave edit mode. */
      details: (name, courtNumbers) => write(
        device.id, () => endpoints.adminDeviceUpdate(device.id, { name, court_numbers: courtNumbers }),
        (row) => row?.name === name && sameCourts(row.court_numbers, courtNumbers),
        {
          done: `${name} now drives ${describeCourts(courtNumbers)}.`, failed: "Could not save that box.",
          still: `${named} is as it was`, whether: `${named} was saved`,
        },
      ),
      buttonMap: (map) => write(
        device.id, () => endpoints.adminDeviceUpdate(device.id, { button_map: map }),
        (row) => row !== undefined && JSON.stringify(row.button_map ?? null) === JSON.stringify(map),
        {
          done: map === null
            ? `${named} uses the club's button map again. It picks that up on its next heartbeat.`
            : `${named} has its own button map. It picks that up on its next heartbeat.`,
          failed: "Could not save that box's buttons.",
          still: `${named}'s buttons are as they were`, whether: `${named}'s buttons were saved`,
        },
      ),
      screen: (layout, marquee) => write(
        device.id, () => endpoints.adminDeviceUpdate(device.id, { lcd_layout: layout, lcd_marquee_enabled: marquee }),
        (row) => row !== undefined && (row.lcd_layout ?? null) === layout && (row.lcd_marquee_enabled ?? null) === marquee,
        {
          done: layout === null
            ? `${named} draws the club's screen layout again. It picks that up the next time it calls in.`
            : `${named} will draw ${layout === "expanded" ? "the expanded 20×4" : "the compact 16×2"} screen. It picks that up the next time it calls in.`,
          failed: "Could not save that box's screen.",
          still: `${named}'s screen is as it was`, whether: `${named}'s screen was saved`,
        },
      ),
      hardware: (patch) => write(
        device.id, () => endpoints.adminDeviceUpdate(device.id, patch),
        (row) => row !== undefined && Object.entries(patch).every(([key, value]) => (row[key as keyof AdminDevice] ?? null) === value),
        {
          done: `${named}'s hardware settings are saved. It picks them up the next time it calls in, and reports what it runs with.`,
          failed: "Could not save that box's hardware settings.",
          still: `${named}'s hardware settings are as they were`, whether: `${named}'s hardware settings were saved`,
        },
      ),
      pushNetwork: () => write(
        device.id, () => endpoints.adminDeviceUpdate(device.id, { push_network: true }),
        (row) => row !== undefined && row.net_src !== "local",
        {
          done: `${named} gets the club's network the next time it calls in.`,
          failed: "Could not send that board the club network.",
          still: `${named} keeps the network it was set up with`, whether: `${named} was sent the club network`,
        },
      ),
      /**
       * Out of service, or back in. `enabled` has been on the API and on the typed client
       * since the row existed and nothing ever sent it — the three mutations above send
       * `{name, court_numbers}`, `{name, gate_key}` and `{button_map}` and nothing else.
       * What the success toast says is {@link enabledToast}'s, which is the same generator
       * the row notice reads.
       */
      setEnabled: async (enabled) => {
        await write(
          device.id, () => endpoints.adminDeviceUpdate(device.id, { enabled }),
          (row) => row?.enabled === enabled,
          {
            done: enabledToast(device, coverage, enabled),
            failed: enabled ? "Could not put that board back in service." : "Could not take that board out of service.",
            still: `${named} is ${enabled ? "still out of service" : "still in service"}`,
            whether: `${named} was ${enabled ? "put back in service" : "taken out of service"}`,
          },
        );
      },
      remove: async () => {
        await write(
          device.id, () => endpoints.adminDeviceDelete(device.id),
          (row) => row === undefined,
          { done: deletedToast(device), failed: "Could not delete that board.", still: `${named} is still there`, whether: `${named} was deleted` },
        );
      },
    };
  };
}

function sameCourts(a: number[] | undefined, b: number[]): boolean {
  return (a ?? []).length === b.length && (a ?? []).every((n, i) => n === b[i]);
}

export function AdminDevicesPage() {
  const toast = useToast();
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [courts, setCourts] = useState<AdminCourt[]>([]);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [buttonMap, setButtonMap] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * One instant per paint, from one timer (A2.7's extraction).
   *
   * Every age on this page used to read `Date.now()` for itself, so three rows rendered
   * across a second boundary could print two different numbers for one moment — and the page
   * only re-rendered on a poll, so the ages stepped in fifteen-second jumps.
   */
  const now = useTicker(true);

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
    setLoadError(null);
    setLoading(false);
  }, []);

  /**
   * The FIRST read, with its failure kept. It used to be `void load()` with no catch, so a
   * failed read left the page on "Loading…" for ever — a screen the outage email sends an
   * admin to, saying nothing at all. Now it says what failed and offers the retry.
   */
  const firstLoad = useCallback(async () => {
    try {
      await load();
    } catch (e) {
      setLoadError(e);
      setLoading(false);
    }
  }, [load]);

  const retryLoad = () => {
    setLoading(true);
    setLoadError(null);
    return firstLoad();
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- as above
  useEffect(() => { void firstLoad(); }, [firstLoad]);

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
  // v3: firmware, network, keys and lights beside the list — each read on its own (useBoardsContext).
  const boardsContext = useBoardsContext(settings, devices, now);

  // The bound a minute button is actually held to: the club's own walk-up maximum, never
  // above the relay's hard cap. The editor already refuses anything past the hard cap; the
  // club's cap is the half nothing on this page knew about.
  const walkUpCap = settings ? Math.min(settings.walk_up_max_minutes, MAX_GRANT_MINUTES) : null;

  /** The club's declared heartbeat, for boxes that do not carry their own. */
  const tenantHeartbeat = settings?.heartbeat_seconds ?? null;

  // Boxes get the editors; doors get a read-only row and a link (A2.5).
  const boxes = devices.filter((d) => !isGate(d));
  const gates = devices.filter((d) => isGate(d));

  return (
    // R11: the shell owns width, gutters and rhythm; no page sets its own root spacing.
    <PageShell width="full">
      <PageHeader
        title="Boards"
        description={`The club's court boxes and door gates — which are calling in, and what their buttons do. This page re-reads the boards every ${REFRESH_MS / 1000} seconds while this tab is in front.`}
        // The outage email says "open the Devices page" and watch the box come back, so the
        // page has to be able to say when it last looked and to look again on demand.
        actions={<RefreshButton onRefresh={() => void refreshNow()} loading={refreshing} />}
        freshness={<Freshness at={checkedAt === null ? null : Date.parse(checkedAt)} />}
      />

      <DeviceApiKeyPanel />

      <Section
        title={(
          <span className="inline-flex items-center gap-2">
            <Cpu size={20} aria-hidden="true" className="shrink-0 text-text-muted" />
            {/* min-w-0 break-words: at a 32 px root "Connected" alone outgrows the row. */}
            <span className="min-w-0 break-words">Connected boards</span>
          </span>
        )}
      >
        <UnacknowledgedBoardsNotice devices={devices} />

        <StateBlock
          loading={loading}
          error={loadError}
          action="read the club's boards"
          failedCaveat="That does not mean none have called in."
          onRetry={() => void retryLoad()}
          /* A club may own only doors: a gate registers itself on this list exactly as a box
             does, so "no boxes" told such a club its doors did not count as devices. The
             heading above is already "Connected boards". */
          empty={devices.length === 0}
          emptyIcon={Cpu}
          emptyTitle="No boards have called in yet."
          emptyHint="Flash one with the key above and power it on — it registers itself."
          skeleton={<CardListSkeleton rows={2} />}
        >
          {/* By the box (R4 form factor): 3 across at 1920, 2 at 1280 — one column was 10,000px. */}
          <AutoGrid min="panel" max={3} gap="md" className="items-start">
            {boxes.map((device) => {
              // One coverage per row: the confirm, the notice and the toast all read it.
              const coverage = coverageWithout(device, devices,
                (d) => isOnline(d, offlineAfterSecondsFor(d, tenantHeartbeat), now));
              return (
                <DeviceRow
                  key={device.id} device={device}
                  boxEditing={{ courts, clubMap: buttonMap, walkUpMax: walkUpCap }}
                  actions={actionsFor(device, coverage)} coverage={coverage}
                  liveness={{ offlineAfter: offlineAfterSecondsFor(device, tenantHeartbeat), now }}
                  context={boardsContext}
                />
              );
            })}
          </AutoGrid>
          {/* A2.5: gates are VISIBLE here and editable only on Doors. */}
          <GateRows gates={gates} tenantHeartbeat={tenantHeartbeat} now={now} />
        </StateBlock>
      </Section>

      <ClubButtonMapCard
        settings={settings} value={buttonMap} onChange={setButtonMap}
        loading={loading} walkUpCap={walkUpCap}
      />

      {/* v3 (device-api §7, §8; member-code §8): what reaches the boards without a cable. */}
      <RemoteFixes
        devices={devices} settings={settings}
        outOfServiceWords={(id) => {
          const board = devices.find((d) => d.id === id);
          if (!board) return "The box stops switching lights on.";
          const coverage = coverageWithout(board, devices, (d) => isOnline(d, offlineAfterSecondsFor(d, tenantHeartbeat), now));
          return outOfServiceConfirm(coverage).replace(/^Out of service\? /, "");
        }}
        onChanged={() => { boardsContext.reload(); void load().catch(() => undefined); }}
      />
    </PageShell>
  );
}
