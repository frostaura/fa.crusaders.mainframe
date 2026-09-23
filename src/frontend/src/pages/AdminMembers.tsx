import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { GroupAssign } from "../components/members/GroupAssign";
import { MemberDialogs, type MemberDialogState } from "../components/members/MemberDialogs";
import { MembersTable, MembersTableSkeleton } from "../components/members/MembersTable";
import { MembersToolbar } from "../components/members/MembersToolbar";
import { RelatedBookingField } from "../components/members/RelatedBookingField";
import type { RowActionHandlers } from "../components/members/RowActions";
import { TopUpSheet } from "../components/members/TopUpSheet";
import {
  DEFAULT_SORT, listSends, nextSort, patchRow, statusCounts, visibleRows, type MemberRow, type Sort, type SortKey,
} from "../components/members/membersModel";
import { useCreditAdjust } from "../components/members/useCreditAdjust";
import { useMemberLifecycle } from "../components/members/useMemberLifecycle";
import { useFingerprints, useGroupMemberships, useMembersList, type GroupsState } from "../components/members/useMembersData";
import { Alert } from "../components/Alert";
import { Button } from "../components/ui/button";
import { Users } from "../components/ui/icons";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { Freshness, RefreshButton } from "../components/ui/refresh-button";
import { StateBlock } from "../components/ui/state-block";
import {
  GROUPS_COPY, MEMBERS_PAGE as COPY, membersCount, statusFilterFrom, type StatusFilter,
} from "../lib/membersCopy";
import { describeFailure } from "../lib/errors";

/**
 * Admin · Members (P5) — the club's people, the application queue, and the way into any one
 * person's record.
 *
 * <p>
 * <b>The row is the way in.</b> "A person's night should be navigated from clicking member in
 * grid" (the founder): every row opens `/admin/members/:userId`, whose tabs hold the bookings,
 * the door history and the night. The name is the accessible link; the ⋯ menu holds the rest.
 * </p>
 *
 * <p>
 * <b>The URL is the filter.</b> `?status=PendingApproval` (the Admin overview and the rail's
 * badge link here) opens the queue, and `?q=` keeps a search — so coming back from a member's
 * page lands where the admin left, and a filtered list can be shared.
 * </p>
 *
 * <p>
 * <b>A failed read is not an empty club.</b> Until the list is read no count is drawn and the
 * failure stays on the screen with a retry; "No members yet." is said only by a read that
 * succeeded and returned nothing.
 * </p>
 */
export default function AdminMembersPage() {
  const list = useMembersList();
  const [params, setParams] = useSearchParams();
  const status = statusFilterFrom(params.get("status"));
  const query = params.get("q") ?? "";
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [dialog, setDialog] = useState<MemberDialogState>(null);
  const [assigning, setAssigning] = useState<MemberRow | null>(null);
  const groups = useGroupMemberships(listSends(list.members, "groups"));
  const prints = useFingerprints();
  const lifecycle = useMemberLifecycle({ load: list.load, setMembers: list.setMembers });
  const credit = useCreditAdjust(list.setMembers);

  const setParam = useCallback((key: "status" | "q", value: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  }, [setParams]);

  const counts = useMemo(() => statusCounts(list.members), [list.members]);
  const rows = useMemo(() => visibleRows(list.members ?? [], status, query, sort), [list.members, status, query, sort]);

  const handlers: RowActionHandlers = {
    approve: lifecycle.approve,
    reject: (member) => setDialog({ kind: "reject", member }),
    topUp: credit.open,
    fingerprints: (member) => setDialog({ kind: "fingerprints", member }),
    reset: (member) => setDialog({ kind: "reset", member }),
    resend: lifecycle.resend,
    changeGroups: setAssigning,
    suspend: (member) => setDialog({ kind: "suspend", member }),
    reactivate: (member) => setDialog({ kind: "reactivate", member }),
    fingerprintCount: (member) => prints.byUser[member.user_id]?.templates.length ?? 0,
  };

  return (
    <PageShell width="wide">
      <PageHeader
        title={COPY.title}
        description={COPY.description}
        actions={<RefreshButton label={COPY.refresh} onRefresh={() => void list.load()} loading={list.loading} />}
        freshness={<Freshness at={list.readAt} />}
      />
      <div className="flex flex-col gap-4">
        <MembersToolbar
          query={query}
          onQuery={(q) => setParam("q", q)}
          status={status}
          onStatus={(s: StatusFilter) => setParam("status", s === "all" ? null : s)}
          counts={counts}
        />
        <MembersBody
          list={list}
          rows={rows}
          groups={groups}
          sort={sort}
          onSort={(key: SortKey) => setSort((s) => nextSort(s, key))}
          handlers={handlers}
          filtered={status !== "all" || query.trim() !== ""}
          onClearFilters={() => setParams(new URLSearchParams(), { replace: true })}
        />
      </div>
      <MemberDialogs
        dialog={dialog}
        setDialog={setDialog}
        lifecycle={lifecycle}
        fingerprints={prints.byUser}
        readFingerprints={prints.read}
      />
      {assigning ? (
        <GroupAssign
          userId={assigning.user_id}
          name={assigning.full_name}
          // What the row shows, when the row knows; otherwise the dialog reads the member's own.
          current={groupsKnown(groups.state, assigning)}
          onClose={() => setAssigning(null)}
          onSaved={(result) => {
            list.setMembers((rows) => patchRow(rows, result.user_id, { groups: result.groups }));
            if (groups.state.status !== "inline") void groups.retry();
          }}
        />
      ) : null}
      {credit.target ? (
        <TopUpSheet
          name={credit.target.full_name}
          // NOT zero where the row has no figure: a balance the console could not read is a
          // balance it must not do arithmetic on.
          balance={typeof credit.target.balance_credits === "number" ? credit.target.balance_credits : null}
          busy={credit.busy}
          bookingError={credit.bookingError}
          onApply={credit.apply}
          onClose={credit.close}
          renderBookingField={() => (
            <RelatedBookingField userId={credit.target!.user_id} value={credit.booking} error={null} onChange={credit.setBooking} />
          )}
        />
      ) : null}
    </PageShell>
  );
}

type BodyProps = {
  list: ReturnType<typeof useMembersList>;
  rows: MemberRow[];
  groups: { state: GroupsState; retry: () => Promise<void> };
  sort: Sort;
  onSort: (key: SortKey) => void;
  handlers: RowActionHandlers;
  filtered: boolean;
  onClearFilters: () => void;
};

/** What the body is showing, decided once so the render below reads as a list of parts. */
function bodyState(members: MemberRow[] | null, rows: MemberRow[], filtered: boolean) {
  const total = members?.length ?? 0;
  const noMatch = total > 0 && rows.length === 0;
  return {
    total,
    empty: members !== null && (total === 0 || noMatch),
    emptyTitle: noMatch ? COPY.noMatchTitle : COPY.emptyTitle,
    emptyHint: noMatch ? COPY.noMatchHint : COPY.emptyHint,
    offerClear: noMatch && filtered,
  };
}

/** Failed · loading · empty · no match · the rows — in that order of precedence, always. */
function MembersBody(props: BodyProps) {
  const { list, rows, groups, onClearFilters } = props;
  if (list.error) return <ListFailed error={list.error} retrying={list.loading} onRetry={() => void list.load()} />;
  const state = bodyState(list.members, rows, props.filtered);
  const read = list.members !== null;
  return (
    <>
      {read ? <p className="-mt-1 text-sm text-text-secondary" aria-live="polite">{membersCount(rows.length, state.total)}</p> : null}
      {read && groups.state.status === "failed" ? <GroupsFailed onRetry={() => void groups.retry()} /> : null}
      <StateBlock
        action={COPY.loadAction}
        loading={!read}
        skeleton={<MembersTableSkeleton />}
        empty={state.empty}
        emptyIcon={Users}
        emptyTitle={state.emptyTitle}
        emptyHint={state.emptyHint}
        emptyAction={state.offerClear ? <Button variant="outline" onClick={onClearFilters}>{COPY.clearFilters}</Button> : null}
      >
        <MembersTable
          rows={rows}
          groupsOf={groupsLookup(groups.state)}
          dateColumn={listSends(list.members, "last_login_at") ? "lastSeen" : "joined"}
          sort={props.sort}
          onSort={props.onSort}
          now={list.readAt ?? 0}
          handlers={props.handlers}
        />
      </StateBlock>
    </>
  );
}

/** The member's groups as the list knows them, or null when it does not (the dialog then reads them). */
function groupsKnown(state: GroupsState, row: MemberRow): NonNullable<MemberRow["groups"]> | null {
  if (state.status === "inline") return row.groups ?? [];
  if (state.status === "ready") return state.byUser.get(row.user_id) ?? [];
  return null;
}

/** How a row's groups are found — or null, and no column, when they could not be read. */
function groupsLookup(state: GroupsState): ((row: MemberRow) => MemberRow["groups"]) | null {
  if (state.status === "failed") return null;
  if (state.status === "inline") return (row) => row.groups ?? [];
  if (state.status === "loading") return () => undefined;
  return (row) => state.byUser.get(row.user_id) ?? [];
}

/**
 * The list could not be read — said in place of the list for as long as that is true, with the
 * retry beside it. Offered even for a 5xx, unlike `StateBlock`'s generic failure: a members list
 * that answered 503 during a restart is the commonest version of this, and an admin with an
 * applicant at the desk needs the button, not a sentence telling them to wait.
 */
function ListFailed({ error, retrying, onRetry }: { error: unknown; retrying: boolean; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-danger-strong p-4 sm:p-6">
      <Alert tone="danger" className="w-full">
        {describeFailure(error, { action: COPY.loadAction })}
        {` ${COPY.loadCaveat}`}
      </Alert>
      <Button variant="outline" pending={retrying} onClick={onRetry}>{COPY.retry}</Button>
    </div>
  );
}

function GroupsFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-strong">
      <span className="min-w-0 flex-1">{GROUPS_COPY.failed}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>{GROUPS_COPY.retry}</Button>
    </div>
  );
}
