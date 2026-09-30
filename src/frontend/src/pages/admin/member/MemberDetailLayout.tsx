import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { GroupAssign } from "@/components/members/GroupAssign";
import { RelatedBookingField } from "@/components/members/RelatedBookingField";
import { TopUpSheet } from "@/components/members/TopUpSheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CalendarBlank, Lock, PencilSimple, Plus, ShieldCheck, UserFocus, UsersThree } from "@/components/ui/icons";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import type { MemberGroupChip } from "@/lib/adminApi";
import { errorCode } from "@/lib/api";
import { ASSIGN_COPY, tariffLine } from "@/lib/groupsCopy";
import type { MemberDetail } from "@/lib/memberDetailApi";
import { MEMBER_COPY, MEMBER_TABS, STATUS_WORD, statusTone } from "@/lib/memberDetailCopy";
import { heldLine, owedBackQuoteLine } from "@/lib/playersCopy";
import { typography } from "@/lib/typography";
import { cn, formatCredits } from "@/lib/utils";
import { MemberActions } from "./MemberActions";
import { zoneNow } from "./memberTime";
import { displayName, useMemberDetailRead, type MemberDetailContext, type MemberDetailState } from "./useMemberDetail";
import { useMemberTopUp } from "./useMemberTopUp";

/**
 * One member, on one page (R17 — "the per-person views live on the member"; the founder: "a
 * person's night should be navigated from clicking member in grid").
 *
 * <p>
 * <b>Header, then tabs, then the tab.</b> The header is who they are and what they hold — photo,
 * name, status, admin, groups, balance — with the two everyday actions beside the balance (Top
 * up, Book for member) and everything consequential behind one ⋯. Each tab is its own ROUTE
 * (`/admin/members/:userId/wallet` …), so a tab is a link that can be shared, reloaded and
 * reached with Back, and the active one carries `aria-current="page"`.
 * </p>
 *
 * <p>
 * <b>The detail is read once, here, and handed to every tab through the outlet context.</b> A
 * tab that changes money or rights calls `reload`/`patch`, so the header can never disagree with
 * the tab under it about the person's balance or role.
 * </p>
 */
export default function MemberDetailLayout() {
  const { userId = "" } = useParams();
  const state = useMemberDetailRead(userId);
  const { detail, patch, reload } = state;
  // A balance the lost-reply lookup could not re-read is null: read the member again rather
  // than leave the header on the figure from before the movement (review round 2, F3-2).
  const onApplied = useCallback(
    (balance: number | null) => (balance === null ? reload() : patch({ balance_credits: balance })),
    [patch, reload],
  );
  const topUp = useMemberTopUp(userId, detail ? displayName(detail) : "this member", onApplied);

  const context = useMemo<MemberDetailContext | null>(
    () => (detail ? { ...state, detail, name: displayName(detail), openTopUp: topUp.show } : null),
    [state, detail, topUp.show],
  );

  if (!context) return <MemberPending state={state} />;

  return (
    <PageShell width="wide">
      <MemberHeader state={state} detail={context.detail} name={context.name} onTopUp={topUp.show} />
      <div className="flex min-w-0 flex-col gap-6">
        <MemberTabs userId={userId} />
        <Outlet context={context} />
      </div>
      {topUp.open ? (
        <TopUpSheet
          name={context.name}
          balance={context.detail.balance_credits}
          busy={topUp.busy}
          bookingError={topUp.bookingError}
          onApply={topUp.apply}
          onClose={topUp.close}
          renderBookingField={() => (
            <RelatedBookingField userId={userId} value={topUp.booking} error={null} onChange={topUp.setBooking} />
          )}
        />
      ) : null}
    </PageShell>
  );
}

/* ─────────────────────────────── before the first answer ─────────────────────────────── */

/** Loading, failed, or not this club's member — never an empty person. */
function MemberPending({ state }: { state: MemberDetailState }) {
  const notFound = errorCode(state.error) === "member_not_found";
  return (
    <PageShell width="wide">
      <PageHeader back={{ to: MEMBER_COPY.backTo, label: MEMBER_COPY.back }} title={notFound ? MEMBER_COPY.notFoundTitle : MEMBER_COPY.eyebrow} />
      {notFound ? (
        <StateBlock
          empty
          emptyIcon={UserFocus}
          emptyTitle={MEMBER_COPY.notFoundTitle}
          emptyHint={MEMBER_COPY.notFoundHint}
          emptyAction={<Button asChild variant="outline"><Link to={MEMBER_COPY.backTo}>{MEMBER_COPY.notFoundAction}</Link></Button>}
        />
      ) : (
        <StateBlock
          loading={state.loading}
          error={state.error}
          action={MEMBER_COPY.loadAction}
          onRetry={() => void state.reload()}
          skeleton={<MemberSkeleton />}
        />
      )}
    </PageShell>
  );
}

function MemberSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4 rounded-xl border border-border bg-bg-surface p-4 sm:p-6">
        <Skeleton className="size-14 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="hidden h-10 w-32 sm:block" />
      </div>
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

/* ─────────────────────────────── the header ─────────────────────────────── */

type HeaderProps = { state: MemberDetailState; detail: MemberDetail; name: string; onTopUp: () => void };

function MemberHeader(props: HeaderProps) {
  const { state, detail, name, onTopUp } = props;
  const subline = [detail.email, detail.membership_number].filter(Boolean).join(" · ");
  return (
    <>
      <PageHeader
        back={{ to: MEMBER_COPY.backTo, label: MEMBER_COPY.back }}
        // No "Member" eyebrow: the back link above already says "Members", and on a phone the
        // repeated word cost a line of a header that pushed the tabs off the first screen (P10).
        title={name}
        description={subline}
        actions={(
          <>
            <RefreshButton label={MEMBER_COPY.refresh} onRefresh={() => void state.reload()} loading={state.loading} />
            <MemberActions detail={detail} name={name} onChanged={state.reload} />
          </>
        )}
        freshness={<Freshness at={state.readAt} />}
      />
      {state.error ? (
        // A refresh that failed keeps the last good read on screen — and says so, with a way back.
        <Alert tone="warning" live="polite">
          {MEMBER_COPY.refreshFailed}
        </Alert>
      ) : null}
      <section
        aria-label={`${name} — summary`}
        className="flex flex-col gap-4 rounded-xl border border-border bg-bg-surface p-4 shadow-xs sm:gap-5 sm:p-6 md:flex-row md:items-center md:justify-between"
      >
        <Identity detail={detail} name={name} state={state} />
        <BalancePanel detail={detail} name={name} onTopUp={onTopUp} />
      </section>
    </>
  );
}

function Identity({ detail, name, state }: { detail: MemberDetail; name: string; state: MemberDetailState }) {
  return (
    // Compressed below `sm` (P10 walk): a 40px avatar and a tighter gap, so the tabs are not
    // pushed below the fold of a phone by the header alone.
    <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
      <Avatar size={56} className="size-10 text-sm sm:size-14 sm:text-lg">
        {detail.photo_url ? <AvatarImage src={detail.photo_url} alt="" /> : null}
        <AvatarFallback name={name} />
      </Avatar>
      <div className="flex min-w-0 flex-col gap-1.5 sm:gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(detail.status)}>
            {detail.status ? STATUS_WORD[detail.status] ?? detail.status : MEMBER_COPY.noMembership}
          </Badge>
          {detail.is_admin ? (
            <Badge
              tone="brand"
              icon={detail.admin_source === "config" ? <Lock size={14} weight="bold" aria-hidden="true" /> : <ShieldCheck size={14} weight="bold" aria-hidden="true" />}
            >
              {detail.admin_source === "config" ? MEMBER_COPY.adminFromConfig : MEMBER_COPY.adminBadge}
            </Badge>
          ) : null}
        </div>
        <MemberGroups detail={detail} name={name} state={state} />
      </div>
    </div>
  );
}

/**
 * The member's groups, editable in place (P6, D2): chips, the rate and peak standing they add up
 * to, and "Change groups", which opens GroupAssign — the change's effect on their money is shown
 * before it is saved, and the header takes the saved set straight away, then re-reads.
 */
function MemberGroups({ detail, name, state }: { detail: MemberDetail; name: string; state: MemberDetailState }) {
  const [open, setOpen] = useState(false);
  const rateGroup = detail.tariff ? detail.groups.find((g) => g.id === detail.tariff?.rate_group_id)?.name ?? null : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <GroupChips groups={detail.groups} />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOpen(true)}
          title={ASSIGN_COPY.changeFor(name)}
          icon={<PencilSimple aria-hidden="true" />}
          // 44 × 44 at the least (A11Y F3-19: it measured 42 × 36 at 390).
          className="min-h-touch min-w-touch"
        >
          {/* Below `sm` the pencil sits beside the chips and the words are for the ear only, so
              the control does not take a line of its own in an already tall header (P10 walk). */}
          <span className="sr-only sm:not-sr-only">{ASSIGN_COPY.change}</span>{" "}
          <span className="sr-only">{`for ${name}`}</span>
        </Button>
      </div>
      {detail.tariff ? <p className="text-xs text-text-secondary" data-testid="member-tariff">{tariffLine(detail.tariff, rateGroup)}</p> : null}
      {open ? (
        <GroupAssign
          userId={detail.user_id}
          name={name}
          current={detail.groups}
          onClose={() => setOpen(false)}
          onSaved={(result) => {
            state.patch({ groups: result.groups, tariff: result.tariff });
            void state.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function GroupChips({ groups }: { groups: MemberGroupChip[] }) {
  if (groups.length === 0) return <p className="text-sm text-text-muted">{MEMBER_COPY.noGroups}</p>;
  return (
    <ul aria-label={MEMBER_COPY.groupsLabel} className="flex flex-wrap gap-1.5">
      {groups.map((g) => (
        <li key={g.id}>
          <Badge tone="info" icon={(g.system_key ? <Lock size={14} weight="bold" aria-hidden="true" /> : <UsersThree size={14} weight="bold" aria-hidden="true" />)}>{g.name}</Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * D9 — the parts of the balance that are not free to spend, in the member wallet's own words: a
 * desk reading "170" could not see that 20 of it was held for partners' shares until the games
 * were 48 hours past, or that some was owed back. Nothing when there is none of either.
 */
function BalanceParts({ detail, name }: { detail: MemberDetail; name: string }) {
  const held = detail.held_credits ?? 0;
  const owed = detail.owed_back_credits ?? 0;
  return (
    <>
      {held > 0 ? <dd data-held-line="" className="basis-full text-xs text-text-secondary">{heldLine(held, detail.held_until ?? null, zoneNow())}</dd> : null}
      {owed > 0 ? <dd data-owed-back-line="" className="max-w-xs basis-full text-xs text-text-secondary">{owedBackQuoteLine(owed, name)}</dd> : null}
    </>
  );
}

function BalancePanel({ detail, name, onTopUp }: { detail: MemberDetail; name: string; onTopUp: () => void }) {
  const overdrawn = detail.balance_credits < 0;
  const canBook = detail.status === "Active";
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between md:justify-end md:gap-6">
      {/* On a phone the label sits on the figure's baseline rather than a line above it (P10). */}
      <dl className="flex flex-row flex-wrap items-baseline gap-x-2 sm:flex-col sm:items-start">
        <dt className={typography({ variant: "overline" })}>{MEMBER_COPY.balance}</dt>
        <dd
          data-testid="member-balance"
          className={cn(typography({ variant: "display" }), "text-2xl sm:text-4xl", overdrawn && "text-danger-strong")}
        >
          {formatCredits(detail.balance_credits)}
        </dd>
        {overdrawn ? <dd className="basis-full text-xs text-danger-strong">{MEMBER_COPY.balanceOverdrawn}</dd> : null}
        <BalanceParts detail={detail} name={name} />
      </dl>
      <div className="flex flex-wrap gap-2">
        {/* Only an active member is topped up (F3.10) — the members list offers no Top up
            to anybody else, and a turned-down applicant was offered one here. */}
        {canBook ? (
          <Button onClick={onTopUp} icon={<Plus weight="bold" aria-hidden="true" />} className="flex-1 sm:flex-none">
            {MEMBER_COPY.topUp}
          </Button>
        ) : (
          <p className="max-w-xs text-sm text-text-muted">{MEMBER_COPY.noTopUp[detail.status ?? "none"] ?? MEMBER_COPY.noTopUp.none}</p>
        )}
        {canBook ? (
          <Button asChild variant="outline" className="flex-1 sm:flex-none">
            <Link to={`/bookings?as=${encodeURIComponent(detail.user_id)}`} title={MEMBER_COPY.bookForHint(name)}>
              <CalendarBlank size={16} aria-hidden="true" />
              {MEMBER_COPY.bookFor}
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ─────────────────────────────── the tabs ─────────────────────────────── */

const TAB = cn(
  "no-lift relative inline-flex min-h-touch shrink-0 items-center whitespace-nowrap px-1",
  "text-sm font-semibold text-text-secondary hover:text-text-primary",
  "transition-colors duration-fast ease-standard motion-reduce:transition-none",
  "focus-visible:-outline-offset-2",
  "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent",
  "aria-[current=page]:text-text-primary aria-[current=page]:after:bg-accent-strong",
);

/**
 * The underline tabs' look (ui/tabs `underline`), as LINKS: each tab is a route, so it is a
 * `NavLink` — it navigates, it can be opened in a new tab, and `aria-current="page"` marks the
 * one showing. Radix Tabs would make them buttons that switch panels, which is the wrong element
 * for a URL. The row scrolls sideways on a phone rather than wrapping into two lines of tabs.
 */
function MemberTabs({ userId }: { userId: string }) {
  const root = `/admin/members/${encodeURIComponent(userId)}`;
  const scroller = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // On a phone the row is wider than the screen; the tab showing is scrolled into the row's view
  // (sideways only — never the page) so "Sign-in & biometrics" is not selected off-screen.
  useEffect(() => {
    const box = scroller.current;
    const current = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (box && current) box.scrollLeft = Math.max(0, current.offsetLeft - 16);
  }, [pathname]);
  return (
    <nav ref={scroller} aria-label={MEMBER_COPY.tabsLabel} className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex w-max min-w-full items-end gap-5 border-b border-border">
        {MEMBER_TABS.map((tab) => (
          <li key={tab.path} className="flex">
            <NavLink to={tab.path ? `${root}/${tab.path}` : root} end className={TAB}>
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
