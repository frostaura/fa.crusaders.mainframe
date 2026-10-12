import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Warning } from "@/components/ui/icons";
import { TextLink } from "@/components/ui/text-link";
import {
  heldLine, HELD_EXPLAINER, INVITE_UNSURE, INVITES_COPY, OWED_BACK_EXPLAINER, acceptedLine, deadlineLine, declinedLine, owedBackLine, partPaidLine,
  payPartLabel, playersCount, shortByLine,
} from "@/lib/playersCopy";
import { useBalance } from "@/lib/useBalance";
import { heldPartsLine } from "@/lib/walletCopy";
import { BUY_MINUTES_PATH } from "@/lib/minutes";
import { Minutes } from "@/components/Minutes";
import { inviteCapSentence, inviteRefusal, inviteWhen, organiserName } from "./inviteFacts";
import { WhenWhole } from "./WhenWhole";
import type { AcceptAnswer } from "@/lib/playersApi";
import type { AcceptFlow } from "./useAcceptFlow";
import { useDailyCap } from "./useDailyCap";
import { cn } from "@/lib/utils";
import type { ProvenBy } from "@/lib/lostReply";

/**
 * What an invite asks, and what saying yes would do — the accept sheet's body, and the whole of
 * the `/j/:token` page's. One component so a sheet and a page can never disagree about a figure.
 *
 * <p>
 * <b>Every money figure is SPENDABLE</b> (`inviteMoney`): the balance less what is held for the
 * member's own partners, because that is what the accept checks. The held part is named beside
 * it with the reason, so a member who can see 2 h on their chip is not puzzled by "1 h 40 min to spend".
 * What they owe back to partners (P11) is subtracted too and named the same way.
 * </p>
 */
export function AcceptBody({ flow, reasonId, headed = false }: {
  flow: AcceptFlow; reasonId: string;
  /** The page's own heading already names the outcome (D6), so the outcome does not repeat it. */
  headed?: boolean;
}) {
  if (flow.outcome) return <OutcomeView flow={flow} headed={headed} />;
  // R12 J12-3 — asking "decline for good?": the game, and that nothing moves. No share, balance,
  // limit or deadline — they describe a yes. One live region says both sentences, once.
  if (flow.askingDecline) {
    return (
      <div className="flex flex-col gap-4">
        <Problem flow={flow} />
        <Alert tone="warning" live="polite" data-decline-final="">
          {`${INVITES_COPY.declineFinal(organiserName(flow.invite))} ${INVITES_COPY.declineNothingMoves}`}
        </Alert>
        <GameFacts flow={flow} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {/* The last answer first: a risen share or a refusal is the reason the sheet changed. */}
      <Problem flow={flow} />
      {flow.blocked === "rereading" ? <p role="status" id={reasonId} className="text-sm text-text-secondary">{flow.readingAgain}</p> : null}
      {/* R18 L18-9 — the game and the money side by side where the invite page has the width. */}
      <div className={FACTS_PAIR}>
        <GameFacts flow={flow} />
        <MoneyFacts flow={flow} />
      </div>
      {flow.blocked === "short" ? <ShortNotice flow={flow} reasonId={reasonId} /> : null}
      <CapEffect flow={flow} reasonId={reasonId} />
      {/* A share of nothing has nothing to pay by and nothing to lapse (R1 F2.14). */}
      {flow.invite.share_minutes > 0 ? (
        <p className="text-sm text-text-secondary" data-deadline="">
          {deadlineLine(flow.invite.share_deadline, organiserName(flow.invite))}
        </p>
      ) : null}
    </div>
  );
}

/**
 * R18 L18-9 — the invite PAGE's card is `@container/invite` (the sheet and the split pane are not):
 * from 44 root ems of card the facts and the figures stand in two columns, as the list's own pane
 * uses its width. Written whole for Tailwind's scanner.
 */
const FACTS_PAIR = "flex flex-col gap-4 @[44rem]/invite:grid @[44rem]/invite:grid-cols-2 @[44rem]/invite:items-start @[44rem]/invite:gap-x-8";

/**
 * One term and its value. The wrapping `div` is the only element between the `dl` and its
 * `dt`/`dd` (R2 F2-11, axe `definition-list`): a layout class goes on it, never on another wrapper.
 */
function Fact({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${className}`}>
      <dt className="text-xs font-medium text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-medium text-text-primary">{children}</dd>
    </div>
  );
}

function GameFacts({ flow }: { flow: AcceptFlow }) {
  const { invite } = flow;
  const name = organiserName(invite);
  return (
    // R12 — one column until the card is 16 root ems wide: two at 320 / 200 % broke "Cou / rt 1".
    <div className="@container">
    {/* R18 L18-1 — and no box of its own under 13 root ems (a card inside the page's card at 150 %+
        text left a 190px column): the facts take the card's width. */}
    <dl className="grid grid-cols-1 gap-x-4 gap-y-3 rounded-xl border-border bg-bg-surface @[13rem]:border @[13rem]:p-3 @[16rem]:grid-cols-2 sm:p-4" data-game-facts="">
      <Fact label={INVITES_COPY.court}>{invite.court_name ?? INVITES_COPY.court}</Fact>
      <Fact label={INVITES_COPY.players}>{playersCount(invite.players)}</Fact>
      <Fact label={INVITES_COPY.when} className="@[16rem]:col-span-2"><WhenWhole when={inviteWhen(invite)} /></Fact>
      <Fact label={INVITES_COPY.organiser} className="@[16rem]:col-span-2">
        {/* R12 — the name drops under the avatar rather than break mid-word ("No / msa" at 320 / 200 %). */}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Avatar size={32}>
            {invite.organiser?.photo_url ? <AvatarImage src={invite.organiser.photo_url} alt="" /> : null}
            <AvatarFallback name={name} />
          </Avatar>
          <span className="max-w-full">{name}</span>
        </span>
      </Fact>
    </dl>
    </div>
  );
}

/** One figure of the accept: whole minutes, read aloud in words (`<Minutes>`), never "h" or "min". */
function MoneyRow({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    // R18 L18-4 — the figure is one piece ("10 min", never "10 / min"): it wraps under its term as a
    // whole where the two cannot share a line (320 / 200 %).
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5" data-money-row="">
      <dt className={cn("min-w-0 break-words", strong ? "text-sm font-semibold text-text-primary" : "text-sm text-text-secondary")}>{label}</dt>
      <dd className={cn("ml-auto whitespace-nowrap", strong ? "text-base font-semibold text-text-primary" : "text-sm text-text-primary")}><Minutes value={value} /></dd>
    </div>
  );
}

function MoneyFacts({ flow }: { flow: AcceptFlow }) {
  const { invite, money } = flow;
  const { held } = useBalance();
  // R9 J9-2 — two or more share deadlines: the total takes no date, each part its own (the Wallet's rule).
  const parts = heldPartsLine(held?.parts);
  // With anything held or owed back the figures are what may be SPENT — said so, as the Book sheet does.
  const holding = money.held > 0 || money.owedBack > 0;
  return (
    <div className="flex flex-col gap-2">
      <dl className="flex flex-col gap-2" data-money="">
        <MoneyRow label={INVITES_COPY.yourShare} value={invite.share_minutes} strong />
        {money.toPay !== invite.share_minutes ? <MoneyRow label={INVITES_COPY.toPayNow} value={money.toPay} /> : null}
        {/* Signed, not clamped: owing partners more than the balance is real, and "short by" adds up from it. */}
        <MoneyRow label={holding ? INVITES_COPY.availableNow : INVITES_COPY.balanceNow} value={money.spendable} />
        {/* Short, there is no "after" — a negative figure would read as an overdraft the accept never allows. */}
        {money.shortBy > 0 ? null : <MoneyRow label={holding ? INVITES_COPY.availableAfter : INVITES_COPY.balanceAfter} value={money.after} strong />}
      </dl>
      {money.held > 0 ? (
        <div className="rounded-lg bg-bg-muted p-3 text-sm text-text-secondary" data-held="">
          <p className="font-medium text-text-primary">{heldLine(money.held, parts ? null : held?.until ?? null)}</p>
          {parts ? <p data-held-parts="" className="tabular-nums text-text-primary">{parts}</p> : null}
          <p>{HELD_EXPLAINER}</p>
        </div>
      ) : null}
      <OwedBack minutes={money.owedBack} />
    </div>
  );
}

/** P11 — what the member owes back to their own partners, which the next minutes bought pay first. */
function OwedBack({ minutes }: { minutes: number }) {
  if (minutes <= 0) return null;
  return (
    <div className="rounded-lg bg-bg-muted p-3 text-sm text-text-secondary" data-owed-back="">
      <p className="font-medium text-text-primary">{owedBackLine(minutes)}</p>
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
  return <CapCounts startsAt={invite.starts_at} timezone={invite.timezone} />;
}

/** R11 J11-3 — said only to a member who HAS a daily cap on the game's day. */
function CapCounts({ startsAt, timezone }: { startsAt: string; timezone?: string }) {
  const capped = useDailyCap(startsAt, timezone);
  if (capped !== true) return null;
  return <p className="text-sm text-text-secondary" data-cap-counts="">{INVITES_COPY.capCounts}</p>;
}

/**
 * The "Buy minutes" link — the package shelf (P13) — carrying the way back to this invite
 * (R1 F2.5): `returnTo` for the buying screens to offer. The invite is also remembered, so
 * Invites resurfaces it whatever they do.
 */
function useBuyPath(): string {
  const { pathname, search } = useLocation();
  return `${BUY_MINUTES_PATH}?returnTo=${encodeURIComponent(`${pathname}${search}`)}`;
}

/**
 * Short of the share: what they need, and the way to get it. The sentence describes Accept.
 * Pay what you can — with something to spend, a second way beside Buy minutes: pay what they have
 * now and leave the rest to the other players (the organiser covers it until they split it).
 */
function ShortNotice({ flow, reasonId }: { flow: AcceptFlow; reasonId: string }) {
  const buy = useBuyPath();
  const part = flow.partMinutes;
  return (
    <div role="status" data-short="" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning-strong/30 bg-warning-soft p-3 text-warning-strong">
      <Warning size={20} weight="bold" aria-hidden="true" className="shrink-0" />
      <p id={reasonId} className="grid min-w-0 flex-1 basis-40 gap-0.5 text-sm">
        <span className="font-semibold">{shortByLine(flow.money.shortBy)}</span>
        <span>{INVITES_COPY.shortBody}</span>
        {part !== null ? <span data-pay-part-body="">{INVITES_COPY.payPartBody}</span> : null}
      </p>
      <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
        {part !== null ? (
          <Button
            variant="secondary" size="sm" className="whitespace-normal [overflow-wrap:anywhere]"
            pending={flow.acceptAction.pending} onClick={flow.payPart} data-pay-part=""
          >
            {payPartLabel(part)}
          </Button>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <Link to={buy}>{INVITES_COPY.buyMinutes}</Link>
        </Button>
      </div>
    </div>
  );
}

/** The last answer that was not a yes: a risen share asks again; a short balance offers a package. */
function Problem({ flow }: { flow: AcceptFlow }) {
  const buy = useBuyPath();
  if (!flow.error) return null;
  const action = flow.declineAction.error ? INVITES_COPY.declineAction : INVITES_COPY.acceptAction;
  const sentence = inviteRefusal(flow.error, action);
  if (flow.errorCode === "share_changed") return <Alert tone="warning" data-share-changed="">{sentence}</Alert>;
  return (
    <div className="flex flex-col items-start gap-2">
      <Alert tone="danger" className="w-full">{sentence}</Alert>
      {flow.errorCode === "insufficient_balance" ? <TextLink to={buy} variant="standalone">{INVITES_COPY.buyMinutes}</TextLink> : null}
    </div>
  );
}

/** The calm confirmation — no confetti (P12). Split by outcome (the complexity gate). */
function OutcomeView({ flow, headed }: { flow: AcceptFlow; headed: boolean }) {
  const name = organiserName(flow.invite);
  const outcome = flow.outcome;
  if (outcome?.kind === "declined") return <DeclinedView name={name} headed={headed} proven={outcome.proven || false} />;
  return <AcceptedView flow={flow} name={name} headed={headed} />;
}

function DeclinedView({ name, headed, proven }: { name: string; headed: boolean; proven: ProvenBy }) {
  return (
    <div role="status" className="flex flex-col gap-1" data-outcome="declined">
      {headed ? null : <p className="text-base font-semibold text-text-primary">{INVITES_COPY.declinedTitle}</p>}
      <p className="text-sm text-text-secondary">{declinedLine(name)}</p>
      {proven ? <p className="text-sm text-text-secondary" data-proven="">{INVITE_UNSURE.declineProvenNoteAfter(proven || undefined)}</p> : null}
    </div>
  );
}

/**
 * R15 J15-11 — what this accept paid, with the seat's total beside it when it is more. Pay what you
 * can — a part payment says what was paid and that the rest is with the organiser.
 */
function acceptedWords(outcome: AcceptFlow["outcome"], name: string): { line: string; answer: AcceptAnswer | null; proven: ProvenBy } {
  if (outcome?.kind !== "accepted") return { line: acceptedLine(0, name, 0), answer: null, proven: false };
  if (outcome.rest && outcome.rest > 0) {
    return { line: partPaidLine(outcome.paidNow ?? 0, name, outcome.rest), answer: outcome.answer, proven: outcome.proven || false };
  }
  const total = outcome.answer.paid_minutes ?? 0;
  const paidNow = Math.min(outcome.paidNow ?? total, total);
  return { line: acceptedLine(paidNow, name, total), answer: outcome.answer, proven: outcome.proven || false };
}

function AcceptedView({ flow, name, headed }: { flow: AcceptFlow; name: string; headed: boolean }) {
  const { line, answer, proven } = acceptedWords(flow.outcome, name);
  const title = headed ? null : <span className="font-semibold">{INVITES_COPY.acceptedTitle}</span>;
  return (
    <div className="flex flex-col items-start gap-3" data-outcome="accepted">
      <Alert tone="success" className="w-full">
        {title}
        {headed ? line : ` — ${line}`}
      </Alert>
      {proven ? <p className="text-sm text-text-secondary" data-proven="">{INVITE_UNSURE.provenNoteAfter(proven || undefined)}</p> : null}
      <TextLink to={`/bookings/${answer?.booking_id ?? flow.invite.booking_id}`} variant="standalone">
        {INVITES_COPY.seeBooking}
      </TextLink>
    </div>
  );
}
