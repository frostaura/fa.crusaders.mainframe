import type { ReactNode } from "react";
import { Section } from "@/components/ui/page-shell";
import { cn, formatCredits } from "@/lib/utils";
import type { BookingDetail, DetailPlayer } from "@/lib/playersApi";
import { DETAIL_CANCELLED, DETAIL_COPY, DETAIL_MONEY, playersWhen } from "@/lib/playersCopy";
import { isCancelled, isLive, organiserName, seatName, statusKey } from "./detailModel";

/**
 * Who paid what. The organiser covered the court at booking; each partner is ASKED for a share,
 * which moves to the organiser when they say yes; a share nobody paid by the deadline lapses to
 * the organiser's cover. Nobody owes anybody — the words here never say "debt" or "owes".
 *
 * <p>
 * Every player on the booking sees every player's paid, consented and unpaid figures (Dean's
 * ruling, 2026-09-28): a split among friends is only fair if it is visible to all of them.
 * </p>
 */
export function MoneyPanel({ detail, actions }: { detail: BookingDetail; actions?: ReactNode }) {
  if (isCancelled(detail)) return <CancelledMoney detail={detail} />;
  const { money } = detail;
  const who = organiserName(detail);
  const deadline = playersWhen(money.share_deadline);
  return (
    <Section title={DETAIL_MONEY.title} description={money.is_split ? DETAIL_MONEY.deadline(deadline) : DETAIL_MONEY.notSplit} actions={actions} data-money-panel="">
      <dl className="grid gap-2 rounded-xl border border-border bg-bg-surface p-4 text-sm">
        <Row term={DETAIL_MONEY.price} value={money.price_credits} />
        <Row term={DETAIL_MONEY.organiserPaid(who)} value={money.organiser_owed_credits} />
        {money.is_split ? <Row term={DETAIL_MONEY.received} value={money.shares_received_credits} /> : null}
        {money.is_split ? <Row term={DETAIL_MONEY.stillToCome} value={money.unpaid_credits} /> : null}
        <Row term={DETAIL_MONEY.net(who)} value={money.organiser_net_credits} total />
      </dl>
      {money.is_split ? <PerPlayer detail={detail} deadline={deadline} /> : null}
      {money.is_split && detail.viewer.role === "organiser" ? (
        <p className="text-sm text-text-secondary">{DETAIL_MONEY.heldNote}</p>
      ) : null}
    </Section>
  );
}

/**
 * R4 V4-3 — a term and its figure, or a name and its line, share a row while they fit and the
 * right-hand part WRAPS under the left one when they do not (200 % text on a phone). Beside a
 * `shrink-0` figure the words were squeezed until names broke mid-word ("Bon/gani").
 */
const PAIR = "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5";
const PAIR_RIGHT = "ml-auto min-w-0 text-right tabular-nums";

function Row({ term, value, total = false }: { term: string; value: number; total?: boolean }) {
  return (
    <div className={cn(PAIR, total ? "border-t border-border pt-2 font-semibold text-text-primary" : "text-text-secondary")}>
      <dt className="min-w-0 break-words">{term}</dt>
      <dd className={PAIR_RIGHT}>{formatCredits(value)}</dd>
    </div>
  );
}

/** One line per seat: what it was asked, what it paid, and what is still to come. */
function lineFor(p: DetailPlayer): string {
  const share = formatCredits(p.share_credits);
  const key = statusKey(p);
  // R2 F2-3 — a share changed after money moved: say the difference, not the booking-time words.
  // ("Asked again" already names the new share beside what they said yes to.)
  const moved = key === "accepted" || key === "paid" ? movedLine(p) : null;
  if (moved) return moved;
  switch (key) {
    case "organiser": return DETAIL_MONEY.coversRow;
    case "guest": return DETAIL_MONEY.guestRow;
    case "settled_outside": return DETAIL_MONEY.settledRow;
    case "lapsed": return DETAIL_MONEY.lapsedRow;
    case "invited": case "open_link": return DETAIL_MONEY.invitedRow(share);
    case "needs_consent": return DETAIL_MONEY.askedAgainRow(share, formatCredits(p.consented_credits));
    case "not_agreed": return DETAIL_MONEY.notAgreedRow(share);
    default: return p.unpaid_credits > 0 ? DETAIL_MONEY.unpaidRow(share) : DETAIL_MONEY.paidRow(formatCredits(p.paid_credits), share);
  }
}

/** Part-paid and asked for more, or paid more than the share now asks — null otherwise. */
function movedLine(p: DetailPlayer): string | null {
  if (p.paid_credits <= 0) return null;
  const paid = formatCredits(p.paid_credits);
  if (p.share_credits < p.paid_credits) {
    return DETAIL_MONEY.goingBackRow(paid, formatCredits(p.paid_credits - p.share_credits));
  }
  if (p.unpaid_credits > 0) return DETAIL_MONEY.askedMoreRow(paid, formatCredits(p.unpaid_credits));
  return null;
}

/** The sentence under the list for a seat still owing: nothing paid yet, or asked for more. */
function unpaidSentence(p: DetailPlayer, name: string, deadline: string, toWhom: string): string {
  if (p.paid_credits > 0) {
    return DETAIL_MONEY.askedMoreSentence(name, formatCredits(p.paid_credits), formatCredits(p.unpaid_credits), deadline, toWhom);
  }
  return DETAIL_MONEY.unpaidSentence(name, deadline, toWhom);
}

function PerPlayer({ detail, deadline }: { detail: BookingDetail; deadline: string }) {
  const live = detail.players.filter(isLive);
  const toWhom = detail.viewer.role === "organiser" ? DETAIL_MONEY.toYou : organiserName(detail) ?? DETAIL_MONEY.toYou;
  // The viewer's own unpaid share is said in their own panel, in the second person.
  const unpaid = live.filter((p) => p.kind === "member" && p.unpaid_credits > 0 && !p.settled_outside
    && p.participant_id !== detail.viewer.participant_id);
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-text-primary">{DETAIL_MONEY.perPlayerTitle}</h3>
      <ul className="grid gap-2 text-sm">
        {live.map((p) => (
          <li key={p.participant_id ?? `seat-${p.seat}`} className={PAIR}>
            <span className="min-w-0 break-words font-medium text-text-primary">
              {p.participant_id !== null && p.participant_id === detail.viewer.participant_id
                ? DETAIL_COPY.you(seatName(p, detail.players)) : seatName(p, detail.players)}
            </span>
            <span className={cn(PAIR_RIGHT, "text-text-secondary")}>{lineFor(p)}</span>
          </li>
        ))}
      </ul>
      {unpaid.map((p) => (
        <p key={`unpaid-${p.participant_id}`} className="text-sm text-text-secondary">
          {unpaidSentence(p, seatName(p, detail.players), deadline, toWhom)}
        </p>
      ))}
    </div>
  );
}

/** What one partner's row says on a cancelled game: paid and standing, came back (R2 F2-4), or nothing owed. */
function cancelledSeatWords(p: BookingDetail["players"][number]): string {
  if (p.paid_credits > 0) return DETAIL_CANCELLED.paidRow(formatCredits(p.paid_credits));
  if ((p.returned_credits ?? 0) > 0) return DETAIL_CANCELLED.returnedRow(formatCredits(p.returned_credits ?? 0));
  return DETAIL_CANCELLED.nothingToPay;
}

/**
 * R1 F2.10 — the money on a cancelled game: what came back and what was paid in the end. No
 * deadline, no "not paid yet", no "Paid 0.00 of 40.00": nothing on it is still being asked.
 */
function CancelledMoney({ detail }: { detail: BookingDetail }) {
  const { money } = detail;
  const who = organiserName(detail);
  const refunded = Math.max(0, money.price_credits - money.organiser_owed_credits);
  const live = detail.players.filter((p) => isLive(p) && p.kind !== "organiser");
  return (
    <Section title={DETAIL_MONEY.title} description={DETAIL_CANCELLED.moneyNote} data-money-panel="">
      <dl className="grid gap-2 rounded-xl border border-border bg-bg-surface p-4 text-sm">
        <Row term={DETAIL_MONEY.price} value={money.price_credits} />
        {/* A split's gross refund is not what the organiser kept (R2 F2-4): said in words below. */}
        {refunded > 0 && !money.is_split ? <Row term={DETAIL_CANCELLED.refunded(who)} value={refunded} /> : null}
        {money.organiser_owed_credits > 0 ? <Row term={DETAIL_CANCELLED.kept(who)} value={money.organiser_owed_credits} /> : null}
        {money.shares_received_credits > 0 ? <Row term={DETAIL_MONEY.received} value={money.shares_received_credits} /> : null}
        <Row term={DETAIL_MONEY.net(who)} value={money.organiser_net_credits} total />
      </dl>
      {refunded > 0 && money.is_split ? <p className="text-sm text-text-secondary" data-split-refund="">{DETAIL_CANCELLED.splitRefundNote(who)}</p> : null}
      {live.length > 0 ? (
        <ul className="grid gap-2 text-sm">
          {live.map((p) => (
            <li key={p.participant_id ?? `seat-${p.seat}`} className={PAIR}>
              <span className="min-w-0 break-words font-medium text-text-primary">{seatName(p, detail.players)}</span>
              <span className={cn(PAIR_RIGHT, "text-text-secondary")}>
                {cancelledSeatWords(p)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
