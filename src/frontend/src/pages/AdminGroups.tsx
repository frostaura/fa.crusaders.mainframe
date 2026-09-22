import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";
import { StateBlock } from "../components/StateBlock";
import { MemberPicker, type PickableMember } from "../components/MemberPicker";
import { useToast } from "../components/Toast";
import { GroupCard } from "../components/groups/GroupCard";
import { clubWeek } from "../components/groups/weekGrid";
import { GroupEditor } from "../components/groups/GroupEditor";
import { GroupMembers, type ClubMember } from "../components/groups/GroupMembers";
import { GroupWeekPreview, MemberPreview } from "../components/groups/GroupPreview";
import { ApiError } from "../lib/api";
import { endpoints } from "../lib/api";
import {
  adminEndpoints, type AdminBulkResult, type MemberBookingRules, type MemberGroup,
  type MemberGroupBody, type Weekday,
} from "../lib/adminApi";
import {
  GROUPS_EMPTY_TITLE, GROUPS_READ_FAILED, MOST_RESTRICTIVE_STANDING, deleteRefusalSentence,
  explainGroupRefusal, groupChangeConsequence,
} from "../lib/groupsCopy";
import type { PaintedWeek } from "../lib/groupsCopy";

/**
 * Member groups, rates, windows and limits — GOAL items 3 and 19, `/admin/groups`.
 *
 * <p>
 * <b>A page, not a section of `/admin/settings`.</b> D3 puts groups inside the settings page;
 * with an editor, a weekly painter, member assignment and two previews it is not a section, and
 * `AdminSettings.tsx` is already thirteen hundred lines and is where every new tenant key also
 * lands. The club-wide limits stay on settings, this page owns the per-group overrides, and the
 * standing statement at the top says how the two compose so an admin never has to guess which
 * screen won.
 * </p>
 *
 * <p>
 * <b>Three reads, and a failure in one does not take the others down.</b> The groups, the club's
 * settings and the club's members are separate facts: a members list that could not be read
 * must not make the page claim the club has no groups, which is the failure mode this whole
 * release is written against.
 * </p>
 *
 * <p>
 * <b>Deleting is refused rather than cascaded.</b> A cascade silently changes what every member
 * of that group may book and what they pay, with no screen showing it. The two 409s are
 * rendered as sentences that name archiving, which is reversible and is the designed way out.
 * </p>
 */

/**
 * Which panel is open under the list.
 *
 * The week preview is NOT one of these and has its own state, deliberately: D3 §6.3 wants the
 * rule visible in the same place it is configured, so the preview stays open while the editor
 * is, and a save that changes the club under it is a thing the preview can then say.
 */
type Panel =
  | { kind: "edit"; id: string }
  | { kind: "members"; id: string }
  | { kind: "member-preview" }
  | null;

type GroupMemberRow = {
  user_id: string;
  name: string;
  membership_number?: string | null;
  added_at?: string;
  added_by_name?: string | null;
};

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
};

export function AdminGroupsPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [groups, setGroups] = useState<MemberGroup[] | null>(null);
  const [clubMembers, setClubMembers] = useState<ClubMember[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [weekPreviewId, setWeekPreviewId] = useState<string | null>(null);
  const [draftGroup, setDraftGroup] = useState<MemberGroup | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [groupsRead, settingsRead, membersRead] = await Promise.allSettled([
      adminEndpoints.memberGroups(),
      endpoints.adminSettingsGet(),
      endpoints.adminMembers(),
    ]);
    if (groupsRead.status === "fulfilled") { setGroups(groupsRead.value.groups); setError(null); }
    else setError(groupsRead.reason);
    if (settingsRead.status === "fulfilled") {
      setSettings(settingsRead.value as unknown as Record<string, unknown>);
    }
    if (membersRead.status === "fulfilled") {
      setClubMembers(membersRead.value.map((m) => ({
        user_id: m.user_id, full_name: m.full_name, membership_number: m.membership_number,
      })));
    }
    setLoading(false);
  }, []);

  // Reading on mount is what this effect is FOR, and `load` is async — every setState inside it
  // runs in a promise callback rather than synchronously in the effect body. The rule cannot
  // see through the `void`, so the directive is here, last line of its comment run and directly
  // above the statement it is about.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
  useEffect(() => { void load(); }, [load]);

  const club = useMemo<PaintedWeek>(() => clubWeek(settings ?? {}), [settings]);
  const numberFrom = (key: string, fallback: number) =>
    typeof settings?.[key] === "number" ? (settings[key] as number) : fallback;
  const sliceMinutes = numberFrom("slice_minutes", 15);
  const courtPrice = numberFrom("slice_price_credits", 0);
  /*
   * `null` where the key is ABSENT, and that is the whole of "unknown is never false" on this
   * page. A club-wide cap the API has not shipped yet is not a club with no cap: the first
   * reads "nobody is limited", which an admin would act on, and only the second is true.
   * Three backend lanes are writing these keys while this screen is being built.
   */
  const capFromSettings = (key: string) =>
    typeof settings?.[key] === "number" ? (settings[key] as number) : null;
  const clubCaps = {
    slotCap: capFromSettings("member_max_slots_per_day"),
    minuteCap: capFromSettings("member_per_day_max_minutes"),
    advanceDays: capFromSettings("advance_booking_days"),
  };
  const timezone = typeof settings?.timezone === "string" ? settings.timezone : undefined;

  /*
   * The club's hours as they were when the open preview was computed. A preview is arithmetic
   * over settings read at one instant, and settings are edited on another screen — so when a
   * reload brings back different hours while a preview is open, the preview says so rather than
   * quietly showing a week that is no longer the club's.
   */
  const [previewBasis, setPreviewBasis] = useState<string | null>(null);
  const clubKey = JSON.stringify(club);
  const previewStale = previewBasis !== null && previewBasis !== clubKey;

  const openPanel = (next: Panel) => {
    setRefusal(null);
    setSaveError(null);
    setPanel(next);
    if (next?.kind === "member-preview") setPreviewBasis(clubKey);
  };

  const openWeekPreview = (id: string) => {
    setRefusal(null);
    setWeekPreviewId(id);
    // The hours the preview below is arithmetic over. When a reload brings back different ones
    // the preview says so rather than quietly showing a week that is no longer the club's.
    setPreviewBasis(clubKey);
  };

  const chosen = panel && "id" in panel ? (groups ?? []).find((g) => g.id === panel.id) ?? null : null;
  const weekPreviewGroup = weekPreviewId === null
    ? null
    : (groups ?? []).find((g) => g.id === weekPreviewId) ?? null;

  const save = async (id: string, body: MemberGroupBody) => {
    setSaving(true);
    setSaveError(null);
    try {
      if (id === "") await adminEndpoints.memberGroupCreate(body);
      else await adminEndpoints.memberGroupUpdate(id, body);
      toast.push({ tone: "success", text: "Saved." });
      setPanel(null);
      setDraftGroup(null);
      await load();
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Archive or delete. The two 409s are the whole point of the delete path and are rendered as
   * sentences with their escape in them — never as a code, and never as a toast that is gone
   * before it has been read.
   */
  const archive = async (group: MemberGroup) => {
    try {
      await adminEndpoints.memberGroupUpdate(group.id, { status: "archived" });
      await load();
      return `${group.name} is archived.`;
    } catch (err) {
      setRefusal(explainGroupRefusal(err, `archive ${group.name}`));
      return "That didn't work.";
    }
  };

  const remove = async (group: MemberGroup) => {
    try {
      await adminEndpoints.memberGroupDelete(group.id);
      await load();
      return `${group.name} is deleted.`;
    } catch (err) {
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

  const editing = panel?.kind === "edit"
    ? (panel.id === "" ? draftGroup ?? BLANK : chosen)
    : null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Member groups</h1>
        <p className="text-sm text-text-secondary">
          What each kind of member pays for a slot, when they may book, and how many slots a day
          they may hold. The club-wide limits live under Booking on the settings page.
        </p>
      </header>

      {/* Standing, not polite: this page re-renders on every save, and a polite region would
          announce the same paragraph each time. */}
      <Alert tone="info" live="standing" announceKey="groups-most-restrictive">
        {MOST_RESTRICTIVE_STANDING}
      </Alert>

      {refusal && <Alert tone="danger" live="assertive">{refusal}</Alert>}

      {/* A failed RE-read with rows in hand: the rows stay, and this says they are not being
          updated. A failed FIRST read has nothing to qualify and goes to StateBlock below. */}
      {error != null && groups !== null && (
        <Alert tone="danger" live="standing" announceKey="groups-read-failed">{GROUPS_READ_FAILED}</Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary" className="min-h-11"
          onClick={() => { setDraftGroup(BLANK); openPanel({ kind: "edit", id: "" }); }}
        >
          Create a group
        </Button>
        <Button variant="outline" className="min-h-11" onClick={() => openPanel({ kind: "member-preview" })}>
          Preview for one member
        </Button>
      </div>

      <StateBlock
        loading={loading}
        // Only where there is nothing to fall back on. Rows the club already gave us are still
        // the last true thing it said; the band above is what stops them being a claim.
        error={groups === null ? error : null}
        action="read the club's groups"
        codes={{}}
        failedCaveat={GROUPS_READ_FAILED.replace("Couldn't read the club's groups. ", "")}
        onRetry={() => void load()}
        empty={!loading && !error && (groups ?? []).length === 0}
        emptyTitle={GROUPS_EMPTY_TITLE}
      >
        <div className="space-y-4">
          {(groups ?? []).map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              club={club}
              sliceMinutes={sliceMinutes}
              courtPrice={courtPrice}
              creditsPerZar={settings?.credits_per_zar_regular as number | undefined}
              blockZar={settings?.topup_block_zar as number | undefined}
              onEdit={() => openPanel({ kind: "edit", id: group.id })}
              onMembers={() => openPanel({ kind: "members", id: group.id })}
              onPreview={() => openWeekPreview(group.id)}
              onArchive={() => archive(group)}
              onDelete={() => remove(group)}
            />
          ))}
        </div>
      </StateBlock>

      {editing && (
        <GroupEditor
          key={panel?.kind === "edit" ? panel.id : "new"}
          group={editing}
          club={club}
          sliceMinutes={sliceMinutes}
          courtPrice={courtPrice}
          clubCaps={clubCaps}
          creditsPerZar={settings?.credits_per_zar_regular as number | undefined}
          blockZar={settings?.topup_block_zar as number | undefined}
          saving={saving}
          error={saveError}
          onSave={(body) => void save(panel?.kind === "edit" ? panel.id : "", body)}
          onCancel={() => { setPanel(null); setDraftGroup(null); }}
        />
      )}

      {panel?.kind === "members" && chosen && (
        <GroupMembersPanel
          group={chosen}
          clubMembers={clubMembers ?? []}
          timezone={timezone}
          onClose={() => setPanel(null)}
          onChanged={() => void load()}
        />
      )}

      {weekPreviewGroup && (
        <GroupWeekPreview
          group={weekPreviewGroup}
          club={club}
          sliceMinutes={sliceMinutes}
          clubCaps={clubCaps}
          stale={previewStale}
          onClose={() => { setWeekPreviewId(null); setPreviewBasis(null); }}
        />
      )}

      {panel?.kind === "member-preview" && (
        <MemberPreviewPanel
          clubMembers={clubMembers ?? []}
          groups={groups ?? []}
          sliceMinutes={sliceMinutes}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}

/**
 * The members panel's own reads and writes, so the page above is not also a member list.
 *
 * Split out for the reason the whole `lib/*Copy` convention exists: a component that fetches
 * three things and renders four panels is one nobody can change safely.
 */
function GroupMembersPanel({ group, clubMembers, timezone, onClose, onChanged }: {
  group: MemberGroup;
  clubMembers: ClubMember[];
  timezone: string | undefined;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [current, setCurrent] = useState<GroupMemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<AdminBulkResult | null>(null);
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

  // Same shape, same reason as the page's own mount read above.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
  useEffect(() => { void read(); }, [read]);

  const add = async (userIds: string[]) => {
    setAdding(true);
    try {
      // Per item, never all-or-nothing — and shown as a screen, because four seconds of toast
      // is not long enough to read six outcomes.
      setResult(await adminEndpoints.memberGroupAddMembers(group.id, userIds));
      await read();
      onChanged();
    } catch (err) {
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

  const drop = async (userId: string) => {
    try {
      await adminEndpoints.memberGroupRemoveMember(group.id, userId);
      await read();
      onChanged();
    } catch (err) {
      const refused = err instanceof ApiError && err.status >= 400 && err.status < 500;
      toast.push({ tone: "danger", text: "Couldn't take them out.", unchanged: refused });
    }
  };

  return (
    <GroupMembers
      group={group}
      clubMembers={clubMembers}
      current={current}
      loading={loading}
      error={error}
      result={result}
      adding={adding}
      onAdd={(ids) => void add(ids)}
      onRemove={(id) => void drop(id)}
      onRetry={() => void read()}
      onClose={onClose}
      timezone={timezone}
    />
  );
}

/** The named-member preview: pick somebody, ask the club what they may actually book. */
function MemberPreviewPanel({ clubMembers, groups, sliceMinutes, onClose }: {
  clubMembers: ClubMember[];
  groups: MemberGroup[];
  sliceMinutes: number;
  onClose: () => void;
}) {
  const [member, setMember] = useState<PickableMember | null>(null);
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
      setProposedRules(await adminEndpoints.memberGroupPreview({ userId, proposedGroupIds: groupIds }));
    } catch {
      // A preview that could not be taken says nothing rather than showing the current rules
      // under a heading that claims they are the proposed ones.
      setProposedRules(null);
    }
  };

  const day = todayInClub();

  return (
    <div className="space-y-2">
      <MemberPreview
        rules={rules}
        memberName={member?.full_name ?? null}
        day={day}
        loading={loading}
        error={error}
        sliceMinutes={sliceMinutes}
        onRetry={() => { if (member) void ask(member.user_id); }}
        groups={groups}
        proposed={proposed}
        proposedRules={proposedRules}
        onPropose={(ids) => { if (member) void propose(member.user_id, ids); }}
        consequence={member && proposedRules
          ? groupChangeConsequence({
            name: member.full_name,
            sliceBefore: rules?.slice_price_credits,
            sliceAfter: proposedRules.slice_price_credits,
          })
          : []}
      >
        <MemberPicker
          members={clubMembers.map((m) => ({
            user_id: m.user_id, full_name: m.full_name, membership_number: m.membership_number,
          }))}
          value={member}
          onChange={(next) => {
            setMember(next);
            setRules(null);
            setProposed(null);
            setProposedRules(null);
            if (next) void ask(next.user_id);
          }}
          label="Which member?"
          hint="Their rules are read from the club's own system, not worked out here."
        />
      </MemberPreview>
      <Button variant="ghost" className="min-h-11" onClick={onClose}>Close</Button>
    </div>
  );
}

/**
 * Which weekday it is, for the sentence the preview writes.
 *
 * The browser's own day rather than the club's, and deliberately only used as a LABEL: the
 * figures all come from the server, which resolves the club's day itself. A console in another
 * zone that said "on a Tuesday" about Wednesday's rules would be wrong, so the endpoint is
 * asked without a `day` and answers for the club's today — see `adminApi.memberBookingRules`.
 */
function todayInClub(): Weekday {
  const names: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return names[new Date().getDay()];
}
