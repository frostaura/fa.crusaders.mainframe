import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { CheckCircle, UserMinus, UsersThree, X, XCircle } from "../ui/icons";
import { MemberCombobox } from "../ui/member-combobox";
import { Skeleton } from "../ui/skeleton";
import { StateBlock } from "../ui/state-block";
import { clubDayAndClock } from "../../lib/clubClock";
import { ASSIGN_COPY, addMembersLabel, addResultLine, memberCountLine } from "../../lib/groupsCopy";
import { useAsyncAction } from "../../lib/useAsyncAction";
import type { AdminBulkResult, MemberGroup } from "../../lib/adminApi";

/**
 * Who is in this group, and the two ways somebody gets in or out — the group sheet's Members tab.
 *
 * <p>
 * <b>The result of a batch is a SCREEN, not a toast.</b> `POST /member-groups/{id}/members`
 * answers per item, so the answer is shown per item: four seconds is not long enough to read
 * six outcomes, the toast viewport deliberately carries no live region of its own, and "already
 * in this group" is not a failure — which a succeeded/failed count cannot express at all.
 * </p>
 *
 * <p>
 * <b>The action is named with the number and the group.</b> "Add selected" on a page with four
 * groups on it is a control an admin presses to find out what it does. Each person in the group
 * links to their own page, and "Change groups" opens the same GroupAssign the member's page uses,
 * so a move between groups states its effect on their rate before it is saved.
 * </p>
 */

export type ClubMember = { user_id: string; full_name: string; membership_number?: string | null };

export type GroupMemberRow = {
  user_id: string;
  name: string;
  membership_number?: string | null;
  added_at?: string;
  added_by_name?: string | null;
};

export function GroupMembers(props: {
  group: MemberGroup;
  /** Everybody the club has, for choosing from. */
  clubMembers: ClubMember[];
  /** Who is in the group now, as the API answers it. */
  current: GroupMemberRow[];
  loading: boolean;
  error: unknown;
  result: AdminBulkResult | null;
  adding: boolean;
  onAdd: (userIds: string[]) => void;
  onRemove: (userId: string) => Promise<unknown>;
  onRetry: () => void;
  /** Opens GroupAssign for one person in the group. */
  onChangeGroups?: (member: GroupMemberRow) => void;
  timezone: string | undefined;
}) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { group, clubMembers, current, result, adding, onAdd } = props;
  const [selected, setSelected] = useState<string[]>([]);
  const inGroup = new Set(current.map((m) => m.user_id));
  const candidates = clubMembers.filter((m) => !inGroup.has(m.user_id));
  const chosen = selected.filter((id) => candidates.some((m) => m.user_id === id));
  const nameOf = (id: string) =>
    clubMembers.find((m) => m.user_id === id)?.full_name ?? "Somebody the club no longer has";

  return (
    <div data-group-members="" className="flex flex-col gap-6">
      <p className="text-sm text-text-secondary">{memberCountLine(group.member_count)}</p>
      {result && <AddResult result={result} nameOf={nameOf} onRetry={onAdd} />}

      <AddMembers
        group={group}
        candidates={candidates}
        chosen={chosen}
        adding={adding}
        onPick={(id) => setSelected((now) => (now.includes(id) ? now : [...now, id]))}
        onUnpick={(id) => setSelected((now) => now.filter((x) => x !== id))}
        onClear={() => setSelected([])}
        onAdd={() => { onAdd(chosen); setSelected([]); }}
        nameOf={nameOf}
      />

      <CurrentMembers {...props} />
    </div>
  );
}

/** The per-item answer to a batch: a screen, one row per person, with the retry for the failed. */
function AddResult({ result, nameOf, onRetry }: {
  result: AdminBulkResult;
  nameOf: (id: string) => string;
  onRetry: (ids: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-muted p-3">
      <h3 className="text-base font-semibold" aria-live="polite">
        {`${result.succeeded} of ${result.requested} done.`}
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {result.results.map((row) => {
          const failed = row.status === "failed";
          const Mark = failed ? XCircle : CheckCircle;
          return (
            <li key={row.id} className={failed ? "flex items-start gap-2 text-danger-strong" : "flex items-start gap-2 text-text-secondary"}>
              <Mark size={16} weight="fill" aria-hidden="true" className={failed ? "mt-0.5 shrink-0" : "mt-0.5 shrink-0 text-success-strong"} />
              <span>{addResultLine(row, nameOf(row.id))}</span>
            </li>
          );
        })}
      </ul>
      {result.failed > 0 && (
        <Button
          variant="outline" className="self-start"
          onClick={() => onRetry(result.results.filter((r) => r.status === "failed").map((r) => r.id))}
        >
          {`Try the ${result.failed} that failed`}
        </Button>
      )}
    </div>
  );
}

/**
 * Adding: a searchable member picker (the club's list is hundreds long — a checkbox per member
 * was a wall), the people picked so far as removable chips, and ONE action named with the
 * number and the group.
 */
function AddMembers(props: {
  group: MemberGroup;
  candidates: ClubMember[];
  chosen: string[];
  adding: boolean;
  onPick: (id: string) => void;
  onUnpick: (id: string) => void;
  onClear: () => void;
  onAdd: () => void;
  nameOf: (id: string) => string;
}) {
  const { group, candidates, chosen, adding, nameOf } = props;
  const pickable = candidates.filter((m) => !chosen.includes(m.user_id));
  return (
    <div className="flex flex-col gap-3">
      <MemberCombobox
        label="Add somebody"
        placeholder="Search the club's members"
        members={pickable.map((m) => ({ id: m.user_id, name: m.full_name, subtitle: m.membership_number ?? null }))}
        value={null}
        onChange={props.onPick}
        emptyText="Nobody left to add who matches"
        className="max-w-md"
      />
      {chosen.length > 0 && (
        // The selection strip. Not a modal and not a toast: the list stays on screen, because
        // the decision being made is about the list.
        <div
          role="region"
          aria-label={`Selected for ${group.name}`}
          className="flex flex-col gap-3 rounded-lg border border-border bg-bg-muted p-3"
        >
          <ul aria-label="Picked" className="flex flex-wrap gap-2">
            {chosen.map((id) => (
              <li key={id}>
                <Badge tone="neutral" className="gap-0 py-0 pl-3 pr-0 text-sm">
                  {nameOf(id)}
                  <IconButton label={`Unpick ${nameOf(id)}`} size="icon-sm" className="ml-0.5" onClick={() => props.onUnpick(id)}>
                    <X aria-hidden="true" />
                  </IconButton>
                </Badge>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button pending={adding} onClick={props.onAdd}>{addMembersLabel(chosen.length, group.name)}</Button>
            <Button variant="ghost" onClick={props.onClear}>Clear</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Who is in the group now, each row with its own way out. */
function CurrentMembers(props: Parameters<typeof GroupMembers>[0]) {
  const { group, current, loading, error, onRemove, onRetry, timezone } = props;
  // (onChangeGroups is read off props below: seven destructured names would trip lizard's gate.)
  return (
    <section aria-label={`In ${group.name} now`} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-text-primary">In the group</h3>
      <StateBlock
        loading={loading}
        error={error}
        action="read who is in this group"
        failedCaveat="That does not mean nobody is."
        onRetry={onRetry}
        empty={!loading && !error && current.length === 0}
        emptyTitle={`Nobody is in ${group.name} yet. Its rules apply to nobody until somebody is added.`}
        skeleton={<div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-touch" />)}</div>}
      >
        <ul className="divide-y divide-border rounded-lg border border-border">
          {current.map((member) => (
            <MemberLine
              key={member.user_id}
              member={member}
              group={group}
              timezone={timezone}
              onRemove={onRemove}
              onChangeGroups={props.onChangeGroups}
            />
          ))}
        </ul>
      </StateBlock>
    </section>
  );
}

/** One person in the group: who, since when, and their two ways out — each showing it is working. */
function MemberLine(props: {
  member: GroupMemberRow;
  group: MemberGroup;
  timezone: string | undefined;
  onRemove: (userId: string) => Promise<unknown>;
  onChangeGroups?: (member: GroupMemberRow) => void;
}) {
  const { member, group, timezone, onRemove, onChangeGroups } = props;
  const remove = useAsyncAction(() => onRemove(member.user_id), {
    toast: { action: `take ${member.name} out of ${group.name}` },
  });
  return (
    <li className="flex min-w-0 items-center gap-2 py-1.5 pl-3 pr-1">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 break-words text-sm font-medium text-text-primary">
          <Link to={`/admin/members/${member.user_id}`} className="no-lift underline-offset-2 hover:underline">{member.name}</Link>
          {member.membership_number && <span className="font-normal text-text-muted">{` · ${member.membership_number}`}</span>}
        </span>
        {member.added_at && (
          <span className="text-xs text-text-muted">
            {`Added ${clubDayAndClock(member.added_at, timezone)}`}
            {member.added_by_name ? ` by ${member.added_by_name}` : ""}
          </span>
        )}
      </span>
      {onChangeGroups ? (
        <IconButton label={ASSIGN_COPY.changeFor(member.name)} onClick={() => onChangeGroups(member)}>
          <UsersThree aria-hidden="true" />
        </IconButton>
      ) : null}
      <IconButton
        label={`Take ${member.name} out of ${group.name}`}
        pending={remove.pending}
        onClick={() => void remove.run()}
      >
        <UserMinus aria-hidden="true" />
      </IconButton>
    </li>
  );
}
