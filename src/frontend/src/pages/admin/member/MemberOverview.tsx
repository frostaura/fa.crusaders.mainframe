import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { MemberPlayCard } from "@/components/play/admin/MemberPlayCard";
import { Button } from "@/components/ui/button";
import { CalendarBlank } from "@/components/ui/icons";
import { Section } from "@/components/ui/page-shell";
import { StateBlock } from "@/components/ui/state-block";
import { TextLink } from "@/components/ui/text-link";
import { clubDate, clubInstant } from "@/lib/clubClock";
import type { MemberDetail } from "@/lib/memberDetailApi";
import { MEMBER_COPY, OVERVIEW_COPY as COPY, accountStatusWord, countOf, withPlayersLine } from "@/lib/memberDetailCopy";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { EmailWithBreaks } from "@/components/members/EmailWithBreaks";
import { BookingLine, StatTile } from "./parts";
import { zoneNow } from "./memberTime";
import { useMemberDetail } from "./useMemberDetail";
import { useOthersOnCourt, type OthersState } from "./useOthersOnCourt";
import { FEATURES } from "@/lib/features";

/**
 * Overview — what a desk needs to know at a glance: when they are next on court, how the last
 * month went, and whether their account can actually sign in.
 */
export function MemberOverview() {
  const { detail, userId } = useMemberDetail();
  const zone = zoneNow();
  const root = `/admin/members/${encodeURIComponent(userId)}`;
  const people = useOthersOnCourt(detail.next_bookings, userId, detail.full_name);
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={COPY.nextTitle}
        description={COPY.nextDescription}
        actions={<TextLink to={`${root}/bookings`} variant="standalone">{COPY.allBookings}</TextLink>}
      >
        <StateBlock
          empty={detail.next_bookings.length === 0}
          emptyIcon={CalendarBlank}
          emptyTitle={COPY.nextEmpty}
          emptyHint={COPY.nextEmptyHint}
          emptyAction={detail.status === "Active" ? (
            <Button asChild variant="outline">
              <Link to={`/bookings?as=${encodeURIComponent(userId)}`}>{MEMBER_COPY.bookFor}</Link>
            </Button>
          ) : null}
        >
          <ul className="flex flex-col gap-3">
            {detail.next_bookings.map((row) => (
              <BookingLine key={row.booking_id} row={row} zone={zone} people={<PeopleOn state={people[row.booking_id]} />} />
            ))}
          </ul>
        </StateBlock>
      </Section>

      <Section title={COPY.countsTitle} description={COPY.countsDescription}>
        <dl className="grid gap-3 sm:grid-cols-3">
          <StatTile label={COPY.bookings} value={detail.counts_30d.bookings} hint={COPY.bookingsHint} />
          <StatTile label={COPY.played} value={detail.counts_30d.sessions_played} hint={COPY.playedHint} />
          <StatTile label={COPY.noShows} value={detail.counts_30d.no_shows} hint={COPY.noShowsHint} tone="danger" />
        </dl>
      </Section>

      {/* P12 — counts only: the member's partners, opponents and badges stay theirs (play.md §9.4). */}
      <MemberPlayCard userId={userId} />

      <Section
        title={COPY.accountTitle}
        actions={<TextLink to={`${root}/access`} variant="standalone">{COPY.manageAccess}</TextLink>}
      >
        <AccountFacts detail={detail} />
      </Section>
    </div>
  );
}

/**
 * "with Sam" under a next booking (D9). Loading is a short skeleton; a booking with nobody else
 * says nothing; a failed read also says nothing rather than implying the member plays alone.
 */
function PeopleOn({ state }: { state: OthersState | undefined }) {
  if (!state || state === "loading") return <Skeleton className="inline-block h-3 w-16 align-middle" />;
  if (state === "failed" || state.length === 0) return null;
  return <>{withPlayersLine(state)}</>;
}

/**
 * R15 L15-3 — a term beside its value only where the RECORD's box has room (a container query in
 * rem, so 200 % text counts), the term column as wide as the longest term (`auto`, every row on
 * the list's own subgrid). It was `sm:` and a fixed 12rem: beside the members list at 200 % the
 * 384px term column left the address a sliver, and a short term sat in a column built for none.
 */
function Fact({ term, children, tone }: { term: string; children: ReactNode; tone?: "warning" }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border py-3 last:border-0 [@container(min-width:30rem)]:col-span-2 [@container(min-width:30rem)]:grid [@container(min-width:30rem)]:grid-cols-subgrid">
      <dt className="text-sm text-text-secondary">{term}</dt>
      <dd className={cn("min-w-0 break-words text-sm font-medium text-text-primary", tone === "warning" && "text-warning-strong")}>
        {children}
      </dd>
    </div>
  );
}

function AccountFacts({ detail }: { detail: MemberDetail }) {
  const zone = zoneNow();
  const applicant = detail.status === "PendingApproval" || detail.status === "Rejected";
  return (
    <div className="[container-type:inline-size]">
      <dl className="rounded-xl border border-border bg-bg-surface px-4 [@container(min-width:30rem)]:px-6 [@container(min-width:30rem)]:grid [@container(min-width:30rem)]:grid-cols-[auto_minmax(0,1fr)] [@container(min-width:30rem)]:gap-x-4">
        <Fact term={COPY.email}><EmailWithBreaks email={detail.email} /></Fact>
        <Fact term={COPY.verified} tone={detail.email_verified ? undefined : "warning"}>
          {detail.email_verified ? COPY.verifiedYes : COPY.unverified}
        </Fact>
        {detail.membership_number ? <Fact term={COPY.membershipNumber}>{detail.membership_number}</Fact> : null}
        {/* An applicant was never a member (F3-12): "Member since" on a pending or turned-down
            page claimed a membership the club has not granted. */}
        <Fact term={applicant ? COPY.appliedOn : COPY.memberSince}>{clubDate(detail.created_at, zone)}</Fact>
        <Fact term={COPY.lastSignIn}>{detail.last_login_at ? clubInstant(detail.last_login_at, zone) : COPY.neverSignedIn}</Fact>
        {detail.status === "Rejected" ? (
          <Fact term={COPY.application}>
            {detail.rejection_reason ? COPY.turnedDownBecause(detail.rejection_reason) : COPY.turnedDown}
          </Fact>
        ) : applicant ? null : (
          // Not on a pending page (F3-12): "Account: active" beside "Awaiting approval" read as
          // two answers to one question. The header's status is the one that counts.
          <Fact term={COPY.accountStatus}>{accountStatusWord(detail.account_status)}</Fact>
        )}
        <Fact term={COPY.passkeys}>{countOf(detail.passkey_count, "passkey", "passkeys")}</Fact>
        {/* P13 §9: no court-box fingerprints while enrolment is switched off. */}
        {FEATURES.fingerprintEnrolment ? (
          <Fact term={COPY.fingerprints}>{countOf(detail.fingerprints.count, "finger enrolled", "fingers enrolled")}</Fact>
        ) : null}
      </dl>
    </div>
  );
}
