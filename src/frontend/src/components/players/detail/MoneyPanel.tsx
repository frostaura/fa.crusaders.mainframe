import { Section } from "@/components/ui/page-shell";
import { formatCredits } from "@/lib/utils";
import type { BookingDetail, DetailPlayer } from "@/lib/playersApi";
import { DETAIL_COPY, DETAIL_MONEY, playersWhen } from "@/lib/playersCopy";
import { isLive, organiserName, seatName, statusKey } from "./detailModel";

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
export function MoneyPanel({ detail }: { detail: BookingDetail }) {
  const { money } = detail;
  const who = organiserName(detail);
  const deadline = playersWhen(money.share_deadline);
  return (
    <Section title={DETAIL_MONEY.title} description={money.is_split ? DETAIL_MONEY.deadline(deadline) : DETAIL_MONEY.notSplit}>
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

function Row({ term, value, total = false }: { term: string; value: number; total?: boolean }) {
  return (
    <div className={total ? "flex items-baseline justify-between gap-4 border-t border-border pt-2 font-semibold text-text-primary" : "flex items-baseline justify-between gap-4 text-text-secondary"}>
      <dt className="min-w-0 break-words">{term}</dt>
      <dd className="shrink-0 tabular-nums">{formatCredits(value)}</dd>
    </div>
  );
}

/** One line per seat: what it was asked, what it paid, and what is still to come. */
function lineFor(p: DetailPlayer): string {
  const share = formatCredits(p.share_credits);
  switch (statusKey(p)) {
    case "organiser": return DETAIL_MONEY.coversRow;
    case "guest": return DETAIL_MONEY.guestRow;
    case "settled_outside": return DETAIL_MONEY.settledRow;
    case "lapsed": return DETAIL_MONEY.lapsedRow;
    case "invited": case "open_link": return DETAIL_MONEY.invitedRow(share);
    case "needs_consent": return DETAIL_MONEY.askedAgainRow(share, formatCredits(p.consented_credits));
    default: return p.unpaid_credits > 0 ? DETAIL_MONEY.unpaidRow(share) : DETAIL_MONEY.paidRow(formatCredits(p.paid_credits), share);
  }
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
          <li key={p.participant_id ?? `seat-${p.seat}`} className="flex items-baseline justify-between gap-4">
            <span className="min-w-0 break-words font-medium text-text-primary">
              {p.participant_id !== null && p.participant_id === detail.viewer.participant_id ? DETAIL_COPY.you(seatName(p)) : seatName(p)}
            </span>
            <span className="text-right tabular-nums text-text-secondary">{lineFor(p)}</span>
          </li>
        ))}
      </ul>
      {unpaid.map((p) => (
        <p key={`unpaid-${p.participant_id}`} className="text-sm text-text-secondary">
          {DETAIL_MONEY.unpaidSentence(seatName(p), deadline, toWhom)}
        </p>
      ))}
    </div>
  );
}
