import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { AdminDialogs, AdminSection } from "@/components/players/admin/AdminPanel";
import { useAdminHands } from "@/components/players/admin/useAdminHands";
import { AdminSeatMenu } from "@/components/players/admin/AdminSeatMenu";
import { Attendance, CancelPanel } from "@/components/players/detail/AttendanceAndCancel";
import { DetailSkeleton } from "@/components/players/detail/DetailSkeleton";
import { MoneyPanel } from "@/components/players/detail/MoneyPanel";
import {
  ChangeSplitButton, InviteButton, OrganiserDialogs, OrganiserSeatButtons,
} from "@/components/players/detail/OrganiserActions";
import { PlayerChips } from "@/components/players/detail/PlayerChips";
import { PlayerPanel } from "@/components/players/detail/PlayerPanel";
import { useBookingDetail, type DetailRead } from "@/components/players/detail/useBookingDetail";
import { useDetailLiveness } from "@/components/players/detail/useDetailLiveness";
import { useOrganiserHands, type Notice } from "@/components/players/detail/useOrganiserHands";
import {
  adminActs, canNudge, canRemove, canShareLink, detailTitle, isCancelled, organiserName, showsResult,
} from "@/components/players/detail/detailModel";
import { ResultCard } from "@/components/play/ResultCard";
import { Button } from "@/components/ui/button";
import { ContextBar } from "@/components/ui/context-bar";
import { useMediaQuery } from "@/components/ui/use-media-query";
import { CalendarBlank } from "@/components/ui/icons";
import { PageHeader, PageShell, Section } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { StateBlock } from "@/components/ui/state-block";
import { StaleNotice } from "@/components/shell/StaleNotice";
import { useAuth } from "@/lib/auth";
import { memberReads } from "@/lib/offline/memberReads";
import { fetchQuery, peekQuery } from "@/lib/offline/queryCache";
import { useDataOwner } from "@/lib/offline/useCachedRead";
import type { EarlyResult } from "@/components/play/useResult";
import type { BookingDetail, DetailPlayer } from "@/lib/playersApi";
import { DETAIL_CANCEL, DETAIL_CANCELLED, DETAIL_COPY, PLAYERS_REFUSAL } from "@/lib/playersCopy";
import { vouchesForResult } from "@/lib/bookingLink";

/**
 * `/bookings/:bookingId` — the booking's own page (P11, D11–D13): the four seats and who is on
 * them, who paid what, who has checked in, and each viewer's hand — the organiser's invite,
 * reminder, link and remove; a partner's review, pull out and decline; the admin's god mode.
 *
 * <p>
 * <b>A 404 is an answer, not a failure.</b> The API says it to anybody not on the game —
 * including a member who declined, pulled out, was removed or lapsed — so it is said as a
 * sentence with the way back, never as a retry.
 * </p>
 */
export default function BookingDetailPage() {
  const { bookingId = "" } = useParams();
  const read = useBookingDetail(bookingId);
  const earlyResult = useEarlyResult(bookingId);
  // R3 M-2 / I-8 — re-read at the start and end, on coming back, on a wallet movement, and on a
  // slow poll while the game is live and nobody is in yet.
  useDetailLiveness(read.data, read.readAt, read.reload);
  const [notice, setNotice] = useState<Notice | null>(null);
  // R3 I-5 — once the page reads the booking as cancelled its own banner says so: the cancel's
  // notice (said while the re-read was on its way) steps aside, so the page says it once.
  const shown = notice && !(notice.text === DETAIL_CANCEL.cancelled && read.data && isCancelled(read.data)) ? notice : null;
  return (
    // R4 form factor (SPEC 3.3): `content` to xl, `wide` from it, where the money stands in a rail.
    <PageShell width="content" className="xl:max-w-wide">
      <PageHeader
        back={{ to: "/bookings", label: DETAIL_COPY.back }}
        title={read.data ? detailTitle(read.data) : DETAIL_COPY.title}
        description={read.data ? headerLine(read.data) : undefined}
        actions={<RefreshButton onRefresh={read.reload} loading={read.loading} label={DETAIL_COPY.refresh} />}
        freshness={<Freshness at={read.readAt} />}
      />
      {shown ? <Alert tone={shown.tone} live="polite" data-detail-notice="">{shown.text}</Alert> : null}
      <DetailBody read={read} say={setNotice} earlyResult={earlyResult} />
    </PageShell>
  );
}

/**
 * Perf lane (2026-09-30) — the result card's first read, started BESIDE the booking's own read
 * rather than a round trip after it (the card mounts only once the booking has arrived), when the
 * link that opened the page vouched that the game is live. Not for
 * an admin: another member's game shows an admin no result (`showsResult`), so theirs would be a
 * wasted read — an admin's own game reads when its card appears, as before. Started once per
 * booking (a ref, so StrictMode's second effect run does not send it twice).
 */
function useEarlyResult(bookingId: string): EarlyResult | null {
  const auth = useAuth();
  // Only when the link that brought us here knew the game is live (`lib/bookingLink`): a
  // cancelled game asks for no result at all (F2.15).
  const vouched = vouchesForResult(useLocation().state);
  // P4-5 (R4 wave B) — a deep link carries no such state, but the phone may: the booking as this
  // member last saw it (`lib/offline`) vouches as well as a link would.
  const { who } = useDataOwner();
  const known = peekQuery(who, memberReads.booking(bookingId).key)?.value as BookingDetail | undefined;
  const member = auth.status === "authenticated" && !auth.isAdmin && (vouched || (known !== undefined && showsResult(known)));
  const started = useRef<EarlyResult | null>(null);
  const [early, setEarly] = useState<EarlyResult | null>(null);
  useEffect(() => {
    if (!member || !bookingId) return;
    if (started.current?.bookingId !== bookingId) {
      // Through the cache, so the card's own first read joins this one rather than repeating it.
      const result = memberReads.bookingResult(bookingId);
      const read = fetchQuery(who, result.key, result.load);
      // Its failure is the card's to show when it takes it; untaken, it is dropped.
      read.catch(() => undefined);
      started.current = { bookingId, read };
    }
    setEarly(started.current);
  }, [member, bookingId, who]);
  return early?.bookingId === bookingId ? early : null;
}

function headerLine(d: BookingDetail): string {
  const who = organiserName(d);
  const by = who ? DETAIL_COPY.organisedBy(who) : DETAIL_COPY.organisedByYou;
  const status = DETAIL_COPY.statusLine[d.status] ?? "";
  return status ? `${by} · ${status}` : by;
}

function DetailBody({ read, say, earlyResult }: { read: DetailRead; say: (notice: Notice) => void; earlyResult: EarlyResult | null }) {
  if (read.notFound) {
    return (
      <StateBlock
        empty
        emptyIcon={CalendarBlank}
        emptyTitle={DETAIL_COPY.notFoundTitle}
        emptyHint={PLAYERS_REFUSAL.booking_not_found}
        emptyAction={<Button asChild variant="outline"><Link to="/bookings">{DETAIL_COPY.backToBookings}</Link></Button>}
      />
    );
  }
  if (!read.data) {
    return (
      <StateBlock
        loading={read.loading}
        error={read.error}
        action={DETAIL_COPY.readAction}
        codes={PLAYERS_REFUSAL}
        onRetry={read.reload}
        skeleton={<DetailSkeleton />}
      />
    );
  }
  return (
    <>
      {/* R4 wave B — the phone's copy, drawn because the club could not be asked: said with its time. */}
      {read.error ? <Alert tone="warning" live="polite">{DETAIL_COPY.refreshFailed}</Alert> : <StaleNotice stale={read.stale} readAt={read.readAt} offline={read.offline} />}
      <DetailView detail={read.data} readAt={read.readAt} reload={read.reload} say={say} earlyResult={earlyResult} />
    </>
  );
}

/**
 * The body's layout (R4 form factor, SPEC 3.3), by the PAGE's width (`@container/page`):
 *
 * <ul>
 *   <li><b>Phone:</b> Players, Money, at the court (your seat, attendance, the result), Cancel,
 *   Admin — the order a member reads it in; the organiser's Invite docked above the tab bar.</li>
 *   <li><b>56rem</b> (lg, `content`): Players across; Money beside the court column; Cancel.</li>
 *   <li><b>72rem</b> (xl, `wide`): Players, then the court column's three blocks side by side,
 *   with Money in a 22rem rail that sticks while the players are worked, Cancel at its foot.</li>
 * </ul>
 * DOM order is the phone's in every layout, so Tab order is reading order. Written whole.
 */
const LAYOUT = [
  "flex flex-col gap-8",
  "@[56rem]/page:grid @[56rem]/page:grid-cols-2 @[56rem]/page:items-start",
  "@[72rem]/page:grid-cols-[minmax(0,1fr)_22rem]",
].join(" ");
const PLAYERS = "@[56rem]/page:col-span-2 @[72rem]/page:col-span-1 @[72rem]/page:col-start-1 @[72rem]/page:row-start-1";
const MONEY = "min-w-0 @[72rem]/page:sticky @[72rem]/page:top-6 @[72rem]/page:col-start-2 @[72rem]/page:row-span-2 @[72rem]/page:row-start-1";
const COURT = "flex min-w-0 flex-col gap-8 @[72rem]/page:col-start-1 @[72rem]/page:row-start-2 @[72rem]/page:grid @[72rem]/page:grid-cols-2 @[72rem]/page:items-start";
const CANCEL = "min-w-0 @[56rem]/page:col-span-2 @[72rem]/page:col-span-1 @[72rem]/page:col-start-2 @[72rem]/page:row-start-3";
const ADMIN = "min-w-0 @[56rem]/page:col-span-2 @[72rem]/page:col-span-1 @[72rem]/page:col-start-1 @[72rem]/page:row-start-3";
const LG_UP = "(min-width: 1024px)";

type ViewProps = {
  detail: BookingDetail; readAt: number | null; reload: () => void; say: (notice: Notice) => void; earlyResult: EarlyResult | null;
};

function DetailView({ detail, readAt, reload, say, earlyResult }: ViewProps) {
  const auth = useAuth();
  const isAdmin = auth.status === "authenticated" && auth.isAdmin;
  const organiser = useOrganiserHands(detail, reload, say);
  const admin = useAdminHands(detail, reload, say);
  const cancelled = isCancelled(detail);
  const canInvite = detail.permissions.can_invite && !cancelled;
  // One Invite button, in one place: JS decides (a CSS-hidden twin is still a second button).
  const wide = useMediaQuery(LG_UP);
  const seatActions = (p: DetailPlayer) => {
    const own = canInvite && (canNudge(p) || canShareLink(p) || canRemove(p));
    const god = isAdmin && adminActs(p).length > 0;
    if (!own && !god) return null;
    return (
      <>
        {own ? <OrganiserSeatButtons player={p} hands={organiser} /> : null}
        {god ? <AdminSeatMenu player={p} onAct={admin.act} players={detail.players} /> : null}
      </>
    );
  };
  return (
    <>
      {cancelled ? <Alert tone="info" live="off" data-cancelled="">{DETAIL_CANCELLED.banner}</Alert> : null}
      <div data-detail-layout="" className={LAYOUT}>
        <Section
          title={DETAIL_COPY.playersTitle}
          description={cancelled ? DETAIL_CANCELLED.playersDescription : DETAIL_COPY.playersDescription}
          // From lg the organiser's verb is beside the heading; on a phone it is docked in thumb
          // reach instead (SPEC §4 "wrong tap reach": top-right is the hardest place to reach).
          actions={canInvite && wide ? <InviteButton hands={organiser} /> : null}
          className={PLAYERS}
          data-players-section=""
        >
          <PlayerChips detail={detail} actions={seatActions} />
        </Section>
        <div data-detail-money="" className={MONEY}>
          <MoneyPanel detail={detail} actions={detail.viewer.role === "organiser" ? <ChangeSplitButton hands={organiser} /> : null} />
        </div>
        <div data-detail-court="" className={COURT}>
          <PlayerPanel detail={detail} reload={reload} say={say} />
          {/* A cancelled game nobody scanned has no attendance to report (R1 F2.10). */}
          {cancelled && !detail.attendance.checked_in_at ? null : <Attendance detail={detail} />}
          {/* P12 — the match result, below attendance: it can be recorded once the box saw the court.
              Asked for only by the game's own players, and never on a cancelled game (R1 F2.15). */}
          {showsResult(detail) ? <ResultCard bookingId={detail.booking_id} freshAt={readAt} firstRead={earlyResult} /> : null}
        </div>
        <div data-detail-cancel="" className={CANCEL}>
          <CancelPanel detail={detail} reload={reload} say={say} />
        </div>
        {isAdmin ? <div className={ADMIN}><AdminSection hands={admin} /></div> : null}
      </div>
      {canInvite && !wide ? (
        <ContextBar position="bottom" until="lg" label={DETAIL_COPY.actionsLabel} primary={<InviteButton hands={organiser} />} />
      ) : null}
      <OrganiserDialogs hands={organiser} />
      <AdminDialogs hands={admin} />
    </>
  );
}
