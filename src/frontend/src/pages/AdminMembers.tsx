import { useCallback, useMemo, useState } from "react";
import { useOutlet } from "react-router-dom";
import { GroupAssign } from "../components/members/GroupAssign";
import { MemberDialogs, type MemberDialogState } from "../components/members/MemberDialogs";
import { MembersTable, MembersTableSkeleton } from "../components/members/MembersTable";
import { MembersToolbar } from "../components/members/MembersToolbar";
import { MemberPicker } from "../components/members/MemberPicker";
import { MembersSplitContext } from "../components/members/membersSplit";
import { useMembersFilters } from "../components/members/useMembersFilters";
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
import { StaleNotice } from "../components/shell/StaleNotice";
import { Button } from "../components/ui/button";
import { Users } from "../components/ui/icons";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { SplitView } from "../components/ui/split-view";
import { Freshness, RefreshButton } from "../components/ui/refresh-button";
import { StateBlock } from "../components/ui/state-block";
import {
  GROUPS_COPY, MEMBERS_PAGE as COPY, MEMBERS_PAGE_SIZE, membersCount, type StatusFilter,
} from "../lib/membersCopy";
import { typography } from "../lib/typography";
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
  const record = useOutlet();
  const filters = useMembersFilters(record === null);
  const { status, query } = filters;
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const paging = usePaging(`${status}|${query}|${sort.key}|${sort.dir}`);
  const [dialog, setDialog] = useState<MemberDialogState>(null);
  const [assigning, setAssigning] = useState<MemberRow | null>(null);
  // R5 P5: beside (or instead of) a member's record the list is the dense picker — no groups, no
  // ⋯ menu — so a deep link no longer reads every group's members and every enrolment for it.
  const groups = useGroupMemberships(listSends(list.members, "groups"), record === null);
  const prints = useFingerprints(record === null);
  const lifecycle = useMemberLifecycle({ load: list.load, setMembers: list.setMembers });
  const credit = useCreditAdjust(list.setMembers);

  const counts = useMemo(() => statusCounts(list.members), [list.members]);
  const rows = useMemo(() => visibleRows(list.members ?? [], status, query, sort), [list.members, status, query, sort]);
  const split = useMemo(() => ({ listHref: filters.listHref }), [filters.listHref]);

  const handlers: RowActionHandlers = {
    approve: lifecycle.approve,
    reject: (member) => setDialog({ kind: "reject", member }),
    topUp: credit.open,
    fingerprints: (member) => setDialog({ kind: "fingerprints", member }),
    reset: (member) => setDialog({ kind: "reset", member }),
    resetCode: (member) => setDialog({ kind: "resetCode", member }),
    resend: lifecycle.resend,
    changeGroups: setAssigning,
    suspend: (member) => setDialog({ kind: "suspend", member }),
    reactivate: (member) => setDialog({ kind: "reactivate", member }),
    fingerprintCount: (member) => prints.byUser[member.user_id]?.templates.length ?? 0,
  };

  const toolbar = (
    <MembersToolbar
      query={query}
      onQuery={(q) => filters.set("q", q)}
      status={status}
      onStatus={(s: StatusFilter) => filters.set("status", s === "all" ? null : s)}
      counts={counts}
      stacked={record !== null}
    />
  );
  const overlays = (
    <MemberOverlays
      dialog={dialog}
      setDialog={setDialog}
      lifecycle={lifecycle}
      prints={prints}
      assigning={assigning}
      setAssigning={setAssigning}
      list={list}
      groups={groups}
      credit={credit}
    />
  );

  // A member is open: the list beside the record from a 64rem box, the record alone below it.
  if (record !== null) {
    return (
      <PageShell width="full">
        <SplitView
          listLabel={COPY.pickerLabel}
          listWidth="28rem"
          detail={<MembersSplitContext.Provider value={split}>{record}</MembersSplitContext.Provider>}
          list={(
            <>
              <h2 className={typography({ variant: "h2" })}>{COPY.pickerTitle}</h2>
              {toolbar}
              <PickerBody list={list} rows={rows} shown={paging.shown} onMore={paging.more} onClearFilters={filters.clear} filtered={status !== "all" || query.trim() !== ""} />
            </>
          )}
        />
        {overlays}
      </PageShell>
    );
  }

  return (
    <PageShell width="full">
      <PageHeader
        title={COPY.title}
        description={COPY.description}
        actions={<RefreshButton label={COPY.refresh} onRefresh={() => void list.load()} loading={list.loading} />}
        freshness={<Freshness at={list.readAt} />}
      />
      <div className="flex flex-col gap-4">
        {toolbar}
        <MembersBody
          list={list}
          rows={rows}
          shown={paging.shown}
          onMore={paging.more}
          groups={groups}
          sort={sort}
          onSort={(key: SortKey) => setSort((s) => nextSort(s, key))}
          handlers={handlers}
          filtered={status !== "all" || query.trim() !== ""}
          onClearFilters={filters.clear}
        />
      </div>
      {overlays}
    </PageShell>
  );
}

/**
 * How many rows are drawn (R4 form factor): a page at a time, back to one page whenever the
 * filter, the search or the sort changes — `key` names that view, so a new view starts over
 * without an effect.
 */
function usePaging(key: string) {
  const [state, setState] = useState({ key, shown: MEMBERS_PAGE_SIZE });
  const shown = state.key === key ? state.shown : MEMBERS_PAGE_SIZE;
  const more = useCallback(() => setState({ key, shown: shown + MEMBERS_PAGE_SIZE }), [key, shown]);
  return { shown, more };
}

type OverlayProps = {
  dialog: MemberDialogState;
  setDialog: React.Dispatch<React.SetStateAction<MemberDialogState>>;
  lifecycle: ReturnType<typeof useMemberLifecycle>;
  prints: ReturnType<typeof useFingerprints>;
  assigning: MemberRow | null;
  setAssigning: (row: MemberRow | null) => void;
  list: ReturnType<typeof useMembersList>;
  groups: { state: GroupsState; retry: () => Promise<void> };
  credit: ReturnType<typeof useCreditAdjust>;
};

/** The list's dialogs and sheets — the same whichever shape the page is in. */
function MemberOverlays(props: OverlayProps) {
  const { dialog, setDialog, lifecycle, prints, assigning, setAssigning, list, groups, credit } = props;
  return (
    <>
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
    </>
  );
}

type PickerBodyProps = {
  list: ReturnType<typeof useMembersList>;
  rows: MemberRow[];
  shown: number;
  onMore: () => void;
  filtered: boolean;
  onClearFilters: () => void;
};

/** The list pane beside a record: failed · loading · empty · the dense rows, as the table's body says them. */
function PickerBody(props: PickerBodyProps) {
  const { list, rows, shown, onMore, filtered, onClearFilters } = props;
  const kept = keepsRows(list);
  if (list.error && !kept) return <ListFailed error={list.error} retrying={list.loading} onRetry={() => void list.load()} />;
  const state = bodyState(list.members, rows, filtered);
  return (
    <>
    <StaleNotice stale={kept} readAt={list.readAt} />
    <StateBlock
      action={COPY.loadAction}
      loading={list.members === null}
      skeleton={<MembersTableSkeleton />}
      empty={state.empty}
      emptyIcon={Users}
      emptyTitle={state.emptyTitle}
      emptyHint={state.emptyHint}
      emptyAction={state.offerClear ? <Button variant="outline" onClick={onClearFilters}>{COPY.clearFilters}</Button> : null}
    >
      <MemberPicker rows={rows} total={state.total} shown={shown} onMore={onMore} />
    </StateBlock>
    </>
  );
}

type BodyProps = {
  list: ReturnType<typeof useMembersList>;
  rows: MemberRow[];
  shown: number;
  onMore: () => void;
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
/**
 * A re-read that failed over a club already read whole: the rows stay, under "Couldn't refresh —
 * showing what we had at 18:04" (R4 wave B, D's StaleNotice). Only a club never read whole is a
 * failure in place of the list — blanking rows already on screen tells the admin less than before.
 */
function keepsRows(list: ReturnType<typeof useMembersList>): boolean {
  return Boolean(list.error) && list.members !== null && list.readAt !== null;
}

function MembersBody(props: BodyProps) {
  const { list, rows, groups, onClearFilters } = props;
  const kept = keepsRows(list);
  if (list.error && !kept) return <ListFailed error={list.error} retrying={list.loading} onRetry={() => void list.load()} />;
  const state = bodyState(list.members, rows, props.filtered);
  const read = list.members !== null;
  return (
    <>
      <StaleNotice stale={kept} readAt={list.readAt} />
      {read ? <p className="-mt-1 text-sm text-text-secondary" aria-live="polite">{membersCount(rows.length, state.total)}</p> : null}
      {list.reading ? <p className="text-sm text-text-muted" role="status">{COPY.readingRest(list.reading.read, list.reading.total)}</p> : null}
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
          rows={rows.slice(0, props.shown)}
          groupsOf={groupsLookup(groups.state)}
          dateColumn={listSends(list.members, "last_login_at") ? "lastSeen" : "joined"}
          sort={props.sort}
          onSort={props.onSort}
          now={list.readAt ?? 0}
          handlers={props.handlers}
        />
        <ShowMore shown={Math.min(props.shown, rows.length)} of={rows.length} onMore={props.onMore} />
      </StateBlock>
    </>
  );
}

/** "Showing 50 of 281 · Show 50 more" under a list longer than a page; nothing under one that is not. */
function ShowMore({ shown, of, onMore }: { shown: number; of: number; onMore: () => void }) {
  if (shown >= of) return null;
  return (
    <div data-members-more="" className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
      <span className="text-sm text-text-secondary">{COPY.showing(shown, of)}</span>
      <Button variant="outline" onClick={onMore}>{COPY.showMore(of - shown)}</Button>
    </div>
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
      {/* A real basis, and a button that may wrap its words (R4, 200% text): at 320 "Read groups
          again" was a 310px box in a 250px band and the page scrolled sideways. */}
      <span className="min-w-0 flex-1 basis-48">{GROUPS_COPY.failed}</span>
      <Button size="sm" variant="ghost" className="!h-auto min-h-9 max-w-full shrink whitespace-normal py-1.5" onClick={onRetry}>{GROUPS_COPY.retry}</Button>
    </div>
  );
}
