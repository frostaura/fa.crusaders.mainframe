import { useState } from "react";
import { Link, useParams } from "react-router-dom";
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
import { useOrganiserHands, type Notice } from "@/components/players/detail/useOrganiserHands";
import {
  adminActs, canNudge, canRemove, canShareLink, detailTitle, isCancelled, organiserName, showsResult,
} from "@/components/players/detail/detailModel";
import { ResultCard } from "@/components/play/ResultCard";
import { Button } from "@/components/ui/button";
import { CalendarBlank } from "@/components/ui/icons";
import { PageHeader, PageShell, Section } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { StateBlock } from "@/components/ui/state-block";
import { useAuth } from "@/lib/auth";
import type { BookingDetail, DetailPlayer } from "@/lib/playersApi";
import { DETAIL_CANCELLED, DETAIL_COPY, PLAYERS_REFUSAL } from "@/lib/playersCopy";

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
  const [notice, setNotice] = useState<Notice | null>(null);
  return (
    <PageShell width="content">
      <PageHeader
        back={{ to: "/bookings", label: DETAIL_COPY.back }}
        title={read.data ? detailTitle(read.data) : DETAIL_COPY.title}
        description={read.data ? headerLine(read.data) : undefined}
        actions={<RefreshButton onRefresh={read.reload} loading={read.loading} label={DETAIL_COPY.refresh} />}
        freshness={<Freshness at={read.readAt} />}
      />
      {notice ? <Alert tone={notice.tone} live="polite" data-detail-notice="">{notice.text}</Alert> : null}
      <DetailBody read={read} say={setNotice} />
    </PageShell>
  );
}

function headerLine(d: BookingDetail): string {
  const who = organiserName(d);
  const by = who ? DETAIL_COPY.organisedBy(who) : DETAIL_COPY.organisedByYou;
  const status = DETAIL_COPY.statusLine[d.status] ?? "";
  return status ? `${by} · ${status}` : by;
}

function DetailBody({ read, say }: { read: DetailRead; say: (notice: Notice) => void }) {
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
      {read.error ? <Alert tone="warning" live="polite">{DETAIL_COPY.refreshFailed}</Alert> : null}
      <DetailView detail={read.data} reload={read.reload} say={say} />
    </>
  );
}

function DetailView({ detail, reload, say }: { detail: BookingDetail; reload: () => void; say: (notice: Notice) => void }) {
  const auth = useAuth();
  const isAdmin = auth.status === "authenticated" && auth.isAdmin;
  const organiser = useOrganiserHands(detail, reload, say);
  const admin = useAdminHands(detail, reload, say);
  const cancelled = isCancelled(detail);
  const canInvite = detail.permissions.can_invite && !cancelled;
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
      <Section
        title={DETAIL_COPY.playersTitle}
        description={cancelled ? DETAIL_CANCELLED.playersDescription : DETAIL_COPY.playersDescription}
        actions={canInvite ? <InviteButton hands={organiser} /> : null}
      >
        <PlayerChips detail={detail} actions={seatActions} />
      </Section>
      <div className="grid gap-8 lg:grid-cols-2">
        <MoneyPanel detail={detail} actions={detail.viewer.role === "organiser" ? <ChangeSplitButton hands={organiser} /> : null} />
        <div className="flex flex-col gap-8">
          <PlayerPanel detail={detail} reload={reload} say={say} />
          {/* A cancelled game nobody scanned has no attendance to report (R1 F2.10). */}
          {cancelled && !detail.attendance.checked_in_at ? null : <Attendance detail={detail} />}
          {/* P12 — the match result, below attendance: it can be recorded once the box saw the court.
              Asked for only by the game's own players, and never on a cancelled game (R1 F2.15). */}
          {showsResult(detail) ? <ResultCard bookingId={detail.booking_id} /> : null}
        </div>
      </div>
      <CancelPanel detail={detail} reload={reload} say={say} />
      {isAdmin ? <AdminSection hands={admin} /> : null}
      <OrganiserDialogs hands={organiser} />
      <AdminDialogs hands={admin} />
    </>
  );
}
