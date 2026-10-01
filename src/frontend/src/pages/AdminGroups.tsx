import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "../components/Alert";
import { Button } from "../components/ui/button";
import { AutoGrid } from "../components/ui/auto-grid";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { Freshness, RefreshButton } from "../components/ui/refresh-button";
import { StateBlock } from "../components/ui/state-block";
import { Plus, UsersThree } from "../components/ui/icons";
import { CardListSkeleton } from "../components/monitoring/parts";
import { MemberCombobox } from "../components/ui/member-combobox";
import { useToast } from "../components/Toast";
import { GroupCard } from "../components/groups/GroupCard";
import { clubWeek } from "../components/groups/weekGrid";
import { courtPricesOf, type ClubContext } from "../components/groups/groupDraft";
import { GroupMembers, type ClubMember, type GroupMemberRow } from "../components/groups/GroupMembers";
import { GroupWeekPreview, MemberPreview } from "../components/groups/GroupPreview";
import { GroupSheet, type GroupSheetTab } from "../components/groups/GroupSheet";
import { GroupAssign } from "../components/members/GroupAssign";
import { ApiError, endpoints, type AdminCourt } from "../lib/api";
import {
  adminEndpoints, type GroupAddResult, type MemberBookingRules, type MemberGroup,
  type GroupWindow, type MemberGroupBody, type Weekday,
} from "../lib/adminApi";
import {
  ADD_LOST, ARCHIVE_COPY, ARCHIVED_HEADING, GROUPS_EMPTY_TITLE, GROUPS_READ_FAILED, GROUP_LOST, GROUP_SHEET, MOST_RESTRICTIVE_STANDING,
  deleteRefusalSentence, explainGroupRefusal, groupChangeConsequence, type PaintedWeek,
} from "../lib/groupsCopy";
import { UnsureOutcome, unsureSentence, writeOrReadBack } from "../lib/lostReply";
import { LOST_REPLY } from "../lib/lostReplyCopy";
import { typography } from "../lib/typography";

/**
 * Groups — the one place a club decides what each kind of member pays, when they may book, how
 * much, what a top-up buys them and whether they get peak hours early (D2, R21: "where do admins
 * configure class groups, allowed times and pricing per class" — "Groups instead please. Class
 * doesn't make sense").
 *
 * <p>
 * <b>A card per group, a sheet per edit.</b> Each card carries the facts an admin opens the page
 * for — rate, peak say, court price, times, limits — so the rule doing the thing somebody
 * complained about is readable without opening anything. Edit and Members open ONE sheet with two
 * tabs, where the list stays behind it.
 * </p>
 *
 * <p>
 * <b>Three reads, and a failure in one does not take the others down.</b> The groups, the club's
 * settings and the club's members are separate facts: a members list that could not be read must
 * not make the page claim the club has no groups.
 * </p>
 *
 * <p>
 * <b>Deleting is refused rather than cascaded; archiving asks why; the built-in group does
 * neither.</b> A cascade silently changes what every member of that group may book and what they
 * pay. The two 409s are rendered as sentences that name archiving, which is reversible and is the
 * designed way out — and the league group, which carries the club's rates, is refused both.
 * </p>
 */

/** Which group the sheet is open on (`""` = a new one), and which of its two tabs. */
type SheetState = { id: string; tab: GroupSheetTab } | null;

/** A new group, as the editor's draft wants it before it has ever been saved. */
const BLANK: MemberGroup = {
  id: "",
  name: "",
  description: null,
  status: "active",
  is_system_default: false,
  pricing: { mode: "inherit_court", multiplier_bps: 10_000, flat_slice_price_credits: null },
  caps: { max_slots_per_day: null, max_minutes_per_day: null, advance_booking_days: null },
  windows: [],
  member_count: 0,
  system_key: null,
  credits_per_zar: null,
  peak_priority: null,
};

/**
 * The club-wide numbers this page reasons against, read out of the settings blob once.
 *
 * <p>
 * <b>`null` where the key is ABSENT, and that is the whole of "unknown is never false" here.</b>
 * A club-wide cap the API has not sent is not a club with no cap: the first reads "nobody is
 * limited", which an admin would act on, and only the second is true.
 * </p>
 */
function clubContextFrom(
  settings: Record<string, unknown> | null, club: ClubContext["club"], courts: AdminCourt[] | null,
): ClubContext & { timezone?: string } {
  const numberOr = <T,>(key: string, fallback: T) =>
    typeof settings?.[key] === "number" ? (settings[key] as number) : fallback;
  return {
    club,
    sliceMinutes: numberOr("slice_minutes", 15),
    // Each court's own price (F3.3) — never the club-wide `slice_price_credits`, which is only
    // the default a NEW court starts at.
    courtPrices: courtPricesOf(courts),
    clubCaps: {
      slotCap: numberOr("member_max_slots_per_day", null),
      minuteCap: numberOr("member_per_day_max_minutes", null),
      advanceDays: numberOr("advance_booking_days", null),
    },
    clubRate: numberOr("credits_per_zar_regular", undefined),
    blockZar: numberOr("topup_block_zar", undefined),
    peakHours: settings?.peak_hours,
    peakAdvanceHours: settings?.peak_advance_hours_for_regular,
    timezone: typeof settings?.timezone === "string" ? settings.timezone : undefined,
  };
}

/** The page's three reads, each failing on its own. */
function usePageReads() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [groups, setGroups] = useState<MemberGroup[] | null>(null);
  const [clubMembers, setClubMembers] = useState<ClubMember[] | null>(null);
  const [courts, setCourts] = useState<AdminCourt[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [readAt, setReadAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [groupsRead, settingsRead, membersRead, courtsRead] = await Promise.allSettled([
      adminEndpoints.memberGroups(),
      endpoints.adminSettingsGet(),
      endpoints.adminMembers(),
      endpoints.adminCourtsList(),
    ]);
    if (courtsRead.status === "fulfilled") setCourts(courtsRead.value);
    if (groupsRead.status === "fulfilled") {
      setGroups(groupsRead.value.groups);
      setError(null);
      setReadAt(Date.now());
    } else setError(groupsRead.reason);
    if (settingsRead.status === "fulfilled") setSettings(settingsRead.value as unknown as Record<string, unknown>);
    if (membersRead.status === "fulfilled") {
      setClubMembers(membersRead.value.map((m) => ({
        user_id: m.user_id, full_name: m.full_name, membership_number: m.membership_number,
      })));
    }
    setLoading(false);
  }, []);

  // Reading on mount is what this effect is FOR; every setState inside `load` runs after an await.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
  useEffect(() => { void load(); }, [load]);

  return { settings, groups, clubMembers, courts, loading, error, readAt, load };
}

/**
 * The page's writes, and what each says when the club refuses.
 *
 * <p>
 * Archive THROWS so its dialog stays open with the refusal in it; delete does not, because its
 * two 409s carry the way out (archiving) and belong on the page, where they stay until read.
 * </p>
 */
/** The group as the list now has it, tested; `{}` when the test holds, null when it does not. */
async function groupNow(id: string, holds: (group: MemberGroup | undefined) => boolean): Promise<object | null> {
  const { groups } = await adminEndpoints.memberGroups();
  return holds(groups.find((g) => g.id === id)) ? {} : null;
}

/**
 * An add whose reply was lost, answered from the group itself: the rows the server would have
 * sent, or null when nobody asked for is newly in the group (the press did not land).
 */
async function addedAccordingToGroup(groupId: string, asked: string[], before: Set<string>): Promise<GroupAddResult | null> {
  const page = await adminEndpoints.memberGroupMembers(groupId);
  const inNow = new Set(page.members.map((m) => m.user_id));
  if (!asked.some((id) => inNow.has(id) && !before.has(id))) return null;
  return {
    results: asked.map((user_id) => ({
      user_id,
      result: !inNow.has(user_id) ? "not_added" : before.has(user_id) ? "already_a_member" : "added",
    })),
  };
}

/**
 * A group save whose reply was lost, answered from the list (R4 carry-over): an edit is saved when
 * the group now reads as sent; a create when a group of this name is listed that was not before.
 */
async function savedAccordingToList(id: string, body: MemberGroupBody, known: ReadonlySet<string>): Promise<object | null> {
  const { groups } = await adminEndpoints.memberGroups();
  const same = (g: MemberGroup) => g.name.trim().toLowerCase() === body.name.trim().toLowerCase();
  if (id === "") return groups.some((g) => !known.has(g.id) && same(g)) ? {} : null;
  const now = groups.find((g) => g.id === id);
  return now && groupReadsAs(now, body) ? {} : null;
}

/** Whether a listed group carries what a save sent: name, description, pricing mode, caps and times. */
function groupReadsAs(g: MemberGroup, body: MemberGroupBody): boolean {
  const times = (w: GroupWindow[] | undefined) => (w ?? []).map((x) => `${x.day} ${x.start}-${x.end}`).sort().join("|");
  const cap = (v: number | null | undefined) => v ?? null;
  return g.name === body.name
    && (g.description ?? null) === (body.description ?? null)
    && g.pricing?.mode === body.pricing.mode
    && cap(g.caps?.max_slots_per_day) === cap(body.caps.maxSlotsPerDay)
    && cap(g.caps?.max_minutes_per_day) === cap(body.caps.maxMinutesPerDay)
    && cap(g.caps?.advance_booking_days) === cap(body.caps.advanceBookingDays)
    && times(g.windows) === times(body.windows);
}

/** A success sentence, with the reply-lost note when the list had to be asked. */
function saidOnce(done: string, proven: boolean): string {
  return proven ? LOST_REPLY.proven(done) : done;
}

function useGroupWrites(
  load: () => Promise<void>, setSheet: (next: SheetState) => void, listed: () => MemberGroup[] | null,
) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const save = async (id: string, body: MemberGroupBody) => {
    setSaving(true);
    setSaveError(null);
    // The groups on screen at the press: a group with this name that was already listed is not
    // this create's (R4 carry-over: a second press after a lost reply said the name was taken).
    const known = new Set((listed() ?? []).map((g) => g.id));
    try {
      const { proven } = await writeOrReadBack(
        async () => {
          if (id === "") await adminEndpoints.memberGroupCreate(body);
          else await adminEndpoints.memberGroupUpdate(id, body);
          return {};
        },
        () => savedAccordingToList(id, body, known),
      );
      const done = id === "" ? GROUP_SHEET.created(body.name) : GROUP_SHEET.saved(body.name);
      toast.push({ tone: "success", text: saidOnce(done, proven) });
      setSheet(null);
      await load();
    } catch (err) {
      if (err instanceof UnsureOutcome) void load();
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  // Archive, restore and delete read a lost reply back from the groups list (review round 3):
  // found as asked → done, with the reply-lost note; not → "nothing changed"; unreadable → not known.
  const archive = async (group: MemberGroup, reason: string) => {
    try {
      const { proven } = await writeOrReadBack(
        async () => { await adminEndpoints.memberGroupUpdate(group.id, { status: "archived", reason }); return {}; },
        () => groupNow(group.id, (g) => g?.status === "archived"),
      );
      toast.push({ tone: "success", text: saidOnce(ARCHIVE_COPY.archived(group.name), proven) });
      await load();
    } catch (err) {
      if (err instanceof UnsureOutcome) void load();
      throw err;
    }
  };

  const restore = async (group: MemberGroup) => {
    try {
      const { proven } = await writeOrReadBack(
        async () => { await adminEndpoints.memberGroupUpdate(group.id, { status: "active" }); return {}; },
        () => groupNow(group.id, (g) => g !== undefined && g.status !== "archived"),
      );
      toast.push({ tone: "success", text: saidOnce(ARCHIVE_COPY.restored(group.name), proven) });
      await load();
    } catch (err) {
      if (err instanceof UnsureOutcome) void load();
      setRefusal(unsureSentence(err, GROUP_LOST.restore(group.name)) ?? explainGroupRefusal(err, `bring ${group.name} back`));
    }
  };

  const remove = async (group: MemberGroup) => {
    try {
      const { proven } = await writeOrReadBack(
        async () => { await adminEndpoints.memberGroupDelete(group.id); return {}; },
        () => groupNow(group.id, (g) => g === undefined),
      );
      await load();
      return saidOnce(`${group.name} is deleted.`, proven);
    } catch (err) {
      const unsure = unsureSentence(err, GROUP_LOST.remove(group.name));
      if (unsure) { void load(); setRefusal(unsure); return "It isn't known yet whether that happened."; }
      const code = err instanceof ApiError ? err.code : null;
      setRefusal(code
        ? deleteRefusalSentence(code, {
          groupName: group.name,
          memberCount: err instanceof ApiError && typeof err.detail("member_count") === "number"
            ? (err.detail("member_count") as number)
            : group.member_count ?? null,
        })
        : explainGroupRefusal(err, `delete ${group.name}`));
      return "That didn't work.";
    }
  };

  return { save, archive, restore, remove, saving, saveError, setSaveError, refusal, setRefusal };
}

export function AdminGroupsPage() {
  const reads = usePageReads();
  const { settings, groups, courts, loading, error, load } = reads;
  const [sheet, setSheet] = useState<SheetState>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [weekPreviewId, setWeekPreviewId] = useState<string | null>(null);
  const [memberPreview, setMemberPreview] = useState(false);
  const writes = useGroupWrites(load, setSheet, () => groups);

  const club = useMemo(() => clubWeek(settings ?? {}), [settings]);
  const context = clubContextFrom(settings, club, courts);

  /*
   * The club's hours as they were when the open preview was computed. Settings are edited on
   * another screen, so when a reload brings back different hours while a preview is open, the
   * preview says so rather than quietly showing a week that is no longer the club's.
   */
  const [previewBasis, setPreviewBasis] = useState<string | null>(null);
  const clubKey = JSON.stringify(club);
  const previewStale = previewBasis !== null && previewBasis !== clubKey;

  const openSheet = (id: string, tab: GroupSheetTab) => {
    writes.setRefusal(null);
    writes.setSaveError(null);
    setDraftKey((k) => k + 1);
    setSheet({ id, tab });
  };

  const rows = groups ?? [];
  const weekPreviewGroup = rows.find((g) => g.id === weekPreviewId) ?? null;

  return (
    <PageShell width="full">
      <PageHeader
        title="Groups"
        description={"What each kind of member pays for a slot and a top-up, when they may book, how much, and "
          + "whether they get peak hours early. Put members in groups from here or from their own page."}
        actions={<RefreshButton label="Refresh groups" onRefresh={() => void load()} loading={loading} />}
        freshness={<Freshness at={reads.readAt} />}
      />

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => openSheet("", "settings")} icon={<Plus aria-hidden="true" />}>Create a group</Button>
        {/* Wraps rather than widening the page at 200% text (R3 X-4). */}
        <Button variant="outline" className="!h-auto min-h-touch whitespace-normal py-2" onClick={() => { setMemberPreview(true); setPreviewBasis(clubKey); }}>
          Preview for one member
        </Button>
      </div>

      <PageAlerts refusal={writes.refusal} rereadFailed={error != null && groups !== null} />

      <GroupList
        groups={groups}
        loading={loading && groups === null}
        error={error}
        context={context}
        onRetry={() => void load()}
        onOpen={openSheet}
        onPreview={(id) => { writes.setRefusal(null); setWeekPreviewId(id); setPreviewBasis(clubKey); }}
        writes={writes}
      />

      <SheetHost
        sheet={sheet}
        setSheet={setSheet}
        draftKey={draftKey}
        rows={rows}
        context={context}
        writes={writes}
        clubMembers={reads.clubMembers ?? []}
        load={load}
      />

      {weekPreviewGroup && (
        <GroupWeekPreview
          group={weekPreviewGroup}
          club={club}
          sliceMinutes={context.sliceMinutes}
          clubCaps={context.clubCaps}
          stale={previewStale}
          onClose={() => { setWeekPreviewId(null); setPreviewBasis(null); }}
        />
      )}

      {memberPreview && (
        <MemberPreviewPanel
          clubMembers={reads.clubMembers ?? []}
          groups={rows}
          sliceMinutes={context.sliceMinutes}
          onClose={() => setMemberPreview(false)}
          club={club}
        />
      )}
    </PageShell>
  );
}

/** The standing rule, and the two things that can be wrong with what the page is showing. */
function PageAlerts({ refusal, rereadFailed }: { refusal: string | null; rereadFailed: boolean }) {
  return (
    <>
      {/* Standing, not polite: this page re-renders on every save. */}
      <Alert tone="info" live="standing" announceKey="groups-most-restrictive">{MOST_RESTRICTIVE_STANDING}</Alert>
      {refusal && <Alert tone="danger" live="assertive">{refusal}</Alert>}
      {/* A failed RE-read with rows in hand: the rows stay, and this says they are not being updated. */}
      {rereadFailed && <Alert tone="danger" live="standing" announceKey="groups-read-failed">{GROUPS_READ_FAILED}</Alert>}
    </>
  );
}

/**
 * The group sheet, and the GroupAssign it can open over itself for one of the group's members.
 *
 * <p>
 * `null`, never a fallback to another group: a sheet open on a group somebody else just deleted
 * closes rather than silently re-pointing at a different one and accepting an edit for it.
 * </p>
 */
function SheetHost(props: {
  sheet: SheetState;
  setSheet: (next: SheetState) => void;
  draftKey: number;
  rows: MemberGroup[];
  context: ReturnType<typeof clubContextFrom>;
  writes: ReturnType<typeof useGroupWrites>;
  clubMembers: ClubMember[];
  load: () => Promise<void>;
}) {
  const { sheet, setSheet, rows, context, writes, load } = props;
  const [assignFor, setAssignFor] = useState<GroupMemberRow | null>(null);
  const editing = sheet === null ? null : sheet.id === "" ? BLANK : rows.find((g) => g.id === sheet.id) ?? null;
  return (
    <>
      {editing && sheet ? (
        <GroupSheet
          key={`${sheet.id}:${props.draftKey}`}
          group={editing}
          tab={sheet.tab}
          onTab={(tab) => setSheet({ ...sheet, tab })}
          context={context}
          saving={writes.saving}
          error={writes.saveError}
          onSave={(body) => void writes.save(sheet.id, body)}
          onClose={() => setSheet(null)}
          members={editing.id ? (
            <GroupMembersPanel
              group={editing}
              clubMembers={props.clubMembers}
              timezone={context.timezone}
              onChanged={() => void load()}
              onChangeGroups={setAssignFor}
            />
          ) : null}
        />
      ) : null}
      {assignFor ? (
        <GroupAssign
          userId={assignFor.user_id}
          name={assignFor.name}
          current={null}
          onClose={() => setAssignFor(null)}
          onSaved={() => void load()}
        />
      ) : null}
    </>
  );
}

/**
 * The club's groups in the three states a read can be in — active ones first, archived ones
 * under their own heading, so a card that no longer applies to anybody never reads as a rule.
 *
 * <p>
 * Only a failed FIRST read reaches `StateBlock`'s error arm: rows the club already gave us are
 * still the last true thing it said, and the band above the list is what stops them being a claim.
 * </p>
 */
function GroupList(props: {
  groups: MemberGroup[] | null;
  loading: boolean;
  error: unknown;
  context: ClubContext;
  onRetry: () => void;
  onOpen: (id: string, tab: GroupSheetTab) => void;
  onPreview: (id: string) => void;
  writes: ReturnType<typeof useGroupWrites>;
}) {
  const { groups, loading, error, onRetry } = props;
  const active = (groups ?? []).filter((g) => g.status !== "archived");
  const archived = (groups ?? []).filter((g) => g.status === "archived");
  return (
    <StateBlock
      loading={loading}
      error={groups === null ? error : null}
      action="read the club's groups"
      codes={{}}
      failedCaveat={GROUPS_READ_FAILED.replace("Couldn't read the club's groups. ", "")}
      onRetry={onRetry}
      empty={!loading && !error && (groups ?? []).length === 0}
      emptyIcon={UsersThree}
      emptyTitle={GROUPS_EMPTY_TITLE}
      skeleton={<CardListSkeleton rows={2} />}
    >
      <div className="flex flex-col gap-8">
        <Cards {...props} groups={active} />
        {archived.length > 0 ? (
          <section aria-labelledby="groups-archived" className="flex flex-col gap-3">
            <h2 id="groups-archived" className={typography({ variant: "h3" })}>{`${ARCHIVED_HEADING} (${archived.length})`}</h2>
            <Cards {...props} groups={archived} />
          </section>
        ) : null}
      </div>
    </StateBlock>
  );
}

function Cards(props: Parameters<typeof GroupList>[0] & { groups: MemberGroup[] }) {
  const { groups, context, onOpen, onPreview, writes } = props;
  return (
    // By the box (R4 form factor, SPEC §3.13): a 26rem card at the least, three across at 1920
    // beside the rail, two at 1280, one on a phone — `xl:grid-cols-2` was the viewport's answer.
    // `fit` (R5 F5-5): two groups at 1920 sat in two of three tracks with the third left empty.
    <AutoGrid min="panel" max={3} gap="lg" fill="fit">
      {groups.map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          club={context.club}
          sliceMinutes={context.sliceMinutes}
          courtPrices={context.courtPrices}
          clubRate={context.clubRate}
          blockZar={context.blockZar}
          onEdit={() => onOpen(group.id, "settings")}
          onMembers={() => onOpen(group.id, "members")}
          onPreview={() => onPreview(group.id)}
          onArchive={(reason) => writes.archive(group, reason)}
          onRestore={() => writes.restore(group)}
          onDelete={() => writes.remove(group)}
        />
      ))}
    </AutoGrid>
  );
}

/**
 * The members tab's own reads and writes, so the page above is not also a member list.
 */
function GroupMembersPanel({ group, clubMembers, timezone, onChanged, onChangeGroups }: {
  group: MemberGroup;
  clubMembers: ClubMember[];
  timezone: string | undefined;
  onChanged: () => void;
  onChangeGroups: (member: GroupMemberRow) => void;
}) {
  const toast = useToast();
  const [current, setCurrent] = useState<GroupMemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<GroupAddResult | null>(null);
  const [addNote, setAddNote] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const read = useCallback(async () => {
    try {
      const page = await adminEndpoints.memberGroupMembers(group.id);
      setCurrent(page.members as GroupMemberRow[]);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [group.id]);

  // Same shape, same reason as the page's own mount read.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
  useEffect(() => { void read(); }, [read]);

  const add = async (userIds: string[]) => {
    setAdding(true);
    setAddNote(null);
    const before = new Set(current.map((m) => m.user_id));
    try {
      // Per item, never all-or-nothing — and shown as a screen, because four seconds of toast
      // is not long enough to read six outcomes. A lost reply reads the group back (R4 carry-over):
      // one save adds everybody or nobody, so anybody new in the group proves the press landed.
      const { value, proven } = await writeOrReadBack(
        () => adminEndpoints.memberGroupAddMembers(group.id, userIds),
        () => addedAccordingToGroup(group.id, userIds, before),
      );
      setResult(value);
      if (proven) setAddNote({ tone: "info", text: ADD_LOST.proven });
      await read();
      onChanged();
    } catch (err) {
      if (err instanceof UnsureOutcome) {
        setResult(null);
        setAddNote({ tone: "danger", text: err.checked ? ADD_LOST.checked(group.name) : ADD_LOST.unchecked(group.name) });
        void read();
        return;
      }
      const refused = err instanceof ApiError && err.status >= 400 && err.status < 500;
      toast.push({
        tone: "danger",
        text: refused ? explainGroupRefusal(err, "add them") : "Couldn't reach the club.",
        unchanged: refused,
        durationMs: 8000,
      });
    } finally {
      setAdding(false);
    }
  };

  /** Throws on failure: the row's own button says it failed (useAsyncAction's toast). */
  const drop = async (userId: string) => {
    await adminEndpoints.memberGroupRemoveMember(group.id, userId);
    await read();
    onChanged();
  };

  return (
    <GroupMembers
      group={group}
      clubMembers={clubMembers}
      current={current}
      loading={loading}
      error={error}
      result={result}
      addNote={addNote}
      adding={adding}
      onAdd={(ids) => void add(ids)}
      onRemove={drop}
      onRetry={() => void read()}
      onChangeGroups={onChangeGroups}
      timezone={timezone}
    />
  );
}

/** The named-member preview: pick somebody, ask the club what they may actually book. */
function MemberPreviewPanel({ clubMembers, groups, sliceMinutes, onClose, club }: {
  clubMembers: ClubMember[];
  groups: MemberGroup[];
  sliceMinutes: number;
  onClose: () => void;
  /** The club's week, from its settings: the preview's "the club itself is open …" line. */
  club: PaintedWeek;
}) {
  const [member, setMember] = useState<ClubMember | null>(null);
  const [rules, setRules] = useState<MemberBookingRules | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [proposed, setProposed] = useState<string[] | null>(null);
  const [proposedRules, setProposedRules] = useState<MemberBookingRules | null>(null);

  const ask = useCallback(async (userId: string) => {
    setLoading(true);
    setError(null);
    try {
      setRules(await adminEndpoints.memberBookingRules(userId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  /** What WOULD apply. Nothing is written, and the fieldset says so. */
  const propose = async (userId: string, groupIds: string[]) => {
    setProposed(groupIds);
    try {
      const answer = await adminEndpoints.memberGroupPreview({ userId, proposedGroupIds: groupIds });
      // `{ current, would_be }` on the wire; an older answer was the rules themselves.
      setProposedRules(answer && "would_be" in answer ? answer.would_be : (answer as unknown as MemberBookingRules));
    } catch {
      // A preview that could not be taken says nothing rather than showing the current rules
      // under a heading that claims they are the proposed ones.
      setProposedRules(null);
    }
  };

  return (
    <MemberPreview
      rules={rules}
      memberName={member?.full_name ?? null}
      day={todayInClub()}
      clubDay={club[todayInClub()]}
      loading={loading}
      error={error}
      sliceMinutes={sliceMinutes}
      onRetry={() => { if (member) void ask(member.user_id); }}
      groups={groups}
      proposed={proposed}
      proposedRules={proposedRules}
      onPropose={(ids) => { if (member) void propose(member.user_id, ids); }}
      onClose={onClose}
      consequence={member && proposedRules
        ? groupChangeConsequence({
          name: member.full_name,
          sliceBefore: rules?.slice_price_credits,
          sliceAfter: proposedRules.slice_price_credits,
        })
        : []}
    >
      <div className="flex flex-col gap-1.5">
        <MemberCombobox
          label="Which member?"
          placeholder="Search the club's members"
          members={clubMembers.map((m) => ({ id: m.user_id, name: m.full_name, subtitle: m.membership_number ?? null }))}
          value={member?.user_id ?? null}
          onChange={(id) => {
            const next = clubMembers.find((m) => m.user_id === id) ?? null;
            setMember(next);
            setRules(null);
            setProposed(null);
            setProposedRules(null);
            if (next) void ask(next.user_id);
          }}
          className="max-w-md"
        />
        <p className="text-sm text-text-muted">Their rules are read from the club&apos;s own system, not worked out here.</p>
      </div>
    </MemberPreview>
  );
}

/**
 * Which weekday it is, for the sentence the preview writes — a LABEL only; the figures all come
 * from the server, which resolves the club's day itself.
 */
function todayInClub(): Weekday {
  const names: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return names[new Date().getDay()];
}
