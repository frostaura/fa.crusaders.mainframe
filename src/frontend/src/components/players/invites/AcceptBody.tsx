import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Warning } from "@/components/ui/icons";
import { TextLink } from "@/components/ui/text-link";
import {
  heldLine, HELD_EXPLAINER, INVITES_COPY, OWED_BACK_EXPLAINER, acceptedLine, deadlineLine, declinedLine, owedBackLine, playersCount,
  shortByLine,
} from "@/lib/playersCopy";
import { signedCredits } from "@/lib/bookingsCopy";
import { useBalance } from "@/lib/balance";
import { formatCredits } from "@/lib/utils";
import { inviteCapSentence, inviteRefusal, inviteWhen, organiserName } from "./inviteFacts";
import type { AcceptFlow } from "./useAcceptFlow";

/**
 * What an invite asks, and what saying yes would do — the accept sheet's body, and the whole of
 * the `/j/:token` page's. One component so a sheet and a page can never disagree about a figure.
 *
 * <p>
 * <b>Every money figure is SPENDABLE</b> (`inviteMoney`): the balance less what is held for the
 * member's own partners, because that is what the accept checks. The held part is named beside
 * it with the reason, so a member who can see 120 cr on their chip is not puzzled by "100 to spend".
 * What they owe back to partners (P11) is subtracted too and named the same way.
 * </p>
 */
export function AcceptBody({ flow, reasonId, headed = false }: {
  flow: AcceptFlow; reasonId: string;
  /** The page's own heading already names the outcome (D6), so the outcome does not repeat it. */
  headed?: boolean;
}) {
  if (flow.outcome) return <OutcomeView flow={flow} headed={headed} />;
  return (
    <div className="flex flex-col gap-4">
      {/* The last answer first: a risen share or a refusal is the reason the sheet changed. */}
      <Problem flow={flow} />
      {flow.blocked === "rereading" ? <p role="status" id={reasonId} className="text-sm text-text-secondary">{flow.readingAgain}</p> : null}
      <GameFacts flow={flow} />
      <MoneyFacts flow={flow} />
      {flow.blocked === "short" ? <ShortNotice shortBy={flow.money.shortBy} reasonId={reasonId} /> : null}
      <CapEffect flow={flow} reasonId={reasonId} />
      {/* A share of nothing has nothing to pay by and nothing to lapse (R1 F2.14). */}
      {flow.invite.share_credits > 0 ? (
        <p className="text-sm text-text-secondary" data-deadline="">
          {deadlineLine(flow.invite.share_deadline, organiserName(flow.invite))}
        </p>
      ) : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs font-medium text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-medium text-text-primary">{children}</dd>
    </div>
  );
}

function GameFacts({ flow }: { flow: AcceptFlow }) {
  const { invite } = flow;
  const name = organiserName(invite);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-border bg-bg-surface p-3 sm:p-4">
      <Fact label={INVITES_COPY.court}>{invite.court_name ?? INVITES_COPY.court}</Fact>
      <Fact label={INVITES_COPY.players}>{playersCount(invite.players)}</Fact>
      <div className="col-span-2">
        <Fact label={INVITES_COPY.when}>{inviteWhen(invite)}</Fact>
      </div>
      <div className="col-span-2 flex items-center gap-3">
        <Avatar size={32}>
          {invite.organiser?.photo_url ? <AvatarImage src={invite.organiser.photo_url} alt="" /> : null}
          <AvatarFallback name={name} />
        </Avatar>
        <Fact label={INVITES_COPY.organiser}>{name}</Fact>
      </div>
    </dl>
  );
}

function MoneyRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? "text-sm font-semibold text-text-primary" : "text-sm text-text-secondary"}>{label}</dt>
      <dd className={strong ? "text-base font-semibold tabular-nums text-text-primary" : "text-sm tabular-nums text-text-primary"}>{value}</dd>
    </div>
  );
}

function MoneyFacts({ flow }: { flow: AcceptFlow }) {
  const { invite, money } = flow;
  const { held } = useBalance();
  return (
    <div className="flex flex-col gap-2">
      <dl className="flex flex-col gap-2" data-money="">
        <MoneyRow label={INVITES_COPY.yourShare} value={formatCredits(invite.share_credits)} strong />
        {money.toPay !== invite.share_credits ? <MoneyRow label={INVITES_COPY.toPayNow} value={formatCredits(money.toPay)} /> : null}
        {/* Signed, not clamped: owing partners more than the balance is real, and "short by" adds up from it. */}
        <MoneyRow label={INVITES_COPY.spendable} value={signedCredits(money.spendable)} />
        {/* Short, there is no "after" — a negative figure would read as an overdraft the accept never allows. */}
        {money.shortBy > 0 ? null : <MoneyRow label={INVITES_COPY.balanceAfter} value={formatCredits(money.after)} strong />}
      </dl>
      {money.held > 0 ? (
        <div className="rounded-lg bg-bg-muted p-3 text-sm text-text-secondary" data-held="">
          <p className="font-medium text-text-primary">{heldLine(money.held, held?.until ?? null)}</p>
          <p>{HELD_EXPLAINER}</p>
        </div>
      ) : null}
      <OwedBack credits={money.owedBack} />
    </div>
  );
}

/** P11 — what the member owes back to their own partners, which the next credit pays first. */
function OwedBack({ credits }: { credits: number }) {
  if (credits <= 0) return null;
  return (
    <div className="rounded-lg bg-bg-muted p-3 text-sm text-text-secondary" data-owed-back="">
      <p className="font-medium text-text-primary">{owedBackLine(credits)}</p>
      <p>{OWED_BACK_EXPLAINER}</p>
    </div>
  );
}

/** D12 — a yes counts against the member's OWN daily cap; when it would break it, say so and stop. */
function CapEffect({ flow, reasonId }: { flow: AcceptFlow; reasonId: string }) {
  const { invite } = flow;
  if (invite.cap) {
    return (
      <Alert tone="warning">
        <span id={flow.blocked === "cap" ? reasonId : undefined} data-cap="">
          {`${inviteCapSentence(invite.cap)} ${INVITES_COPY.capBlocked}`}
        </span>
      </Alert>
    );
  }
  if (invite.status !== "invited") return null;
  return <p className="text-sm text-text-secondary" data-cap-counts="">{INVITES_COPY.capCounts}</p>;
}

/** Short of the share: what they need, and the way to get it. The sentence describes Accept. */
function ShortNotice({ shortBy, reasonId }: { shortBy: number; reasonId: string }) {
  return (
    <div role="status" data-short="" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning-strong/30 bg-warning-soft p-3 text-warning-strong">
      <Warning size={20} weight="bold" aria-hidden="true" className="shrink-0" />
      <p id={reasonId} className="grid min-w-0 flex-1 basis-40 gap-0.5 text-sm">
        <span className="font-semibold">{shortByLine(shortBy)}</span>
        <span>{INVITES_COPY.shortBody}</span>
      </p>
      <Button asChild variant="outline" size="sm" className="ml-auto shrink-0">
        <Link to="/wallet/topup">{INVITES_COPY.topUp}</Link>
      </Button>
    </div>
  );
}

/** The last answer that was not a yes: a risen share asks again; a short balance offers a top-up. */
function Problem({ flow }: { flow: AcceptFlow }) {
  if (!flow.error) return null;
  const action = flow.declineAction.error ? INVITES_COPY.declineAction : INVITES_COPY.acceptAction;
  const sentence = inviteRefusal(flow.error, action);
  if (flow.errorCode === "share_changed") return <Alert tone="warning" data-share-changed="">{sentence}</Alert>;
  return (
    <div className="flex flex-col items-start gap-2">
      <Alert tone="danger" className="w-full">{sentence}</Alert>
      {flow.errorCode === "insufficient_balance" ? <TextLink to="/wallet/topup" variant="standalone">{INVITES_COPY.topUp}</TextLink> : null}
    </div>
  );
}

/** The calm confirmation — no confetti (P12). */
function OutcomeView({ flow, headed }: { flow: AcceptFlow; headed: boolean }) {
  const name = organiserName(flow.invite);
  if (flow.outcome?.kind === "declined") {
    return (
      <div role="status" className="flex flex-col gap-1" data-outcome="declined">
        {headed ? null : <p className="text-base font-semibold text-text-primary">{INVITES_COPY.declinedTitle}</p>}
        <p className="text-sm text-text-secondary">{declinedLine(name)}</p>
      </div>
    );
  }
  const answer = flow.outcome?.kind === "accepted" ? flow.outcome.answer : null;
  return (
    <div className="flex flex-col items-start gap-3" data-outcome="accepted">
      <Alert tone="success" className="w-full">
        {headed ? null : <span className="font-semibold">{INVITES_COPY.acceptedTitle}</span>}
        {headed ? acceptedLine(answer?.paid_credits ?? 0, name) : ` — ${acceptedLine(answer?.paid_credits ?? 0, name)}`}
      </Alert>
      <TextLink to={`/bookings/${answer?.booking_id ?? flow.invite.booking_id}`} variant="standalone">
        {INVITES_COPY.seeBooking}
      </TextLink>
    </div>
  );
}
