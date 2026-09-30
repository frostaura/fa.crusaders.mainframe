import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { playEndpoints, type BookingResultView, type MatchResult } from "@/lib/playApi";
import {
  CONFIRM_SHEET, FORMAT_LABEL, notRecordableLine, PLAY_REFUSAL, playRefusal, playWhen, RESULT_CARD, RESULT_SHEET,
  STATUS_WORD,
} from "@/lib/playCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { ConfirmResultSheet, type ConfirmMode } from "./ConfirmResultSheet";
import { ResultScore } from "./ResultScore";
import { ResultSheet } from "./ResultSheet";
import { confirmingNames, isViewer, outcomeLine, STATUS_TONE } from "./resultFacts";
import { useResult, type ResultRead } from "./useResult";

/**
 * The booking's result (§9.2), below attendance on `/bookings/:id`: record it, see it, confirm
 * or dispute it, edit or withdraw your own — whichever this viewer may, as the server says in
 * `permissions`, never re-derived here.
 *
 * <p>
 * <b>The mail's link opens the matching sheet</b> (`?result=record|confirm`). The sheet is
 * DERIVED from the query and the permissions rather than opened by an effect, so a link to a
 * result that was confirmed meanwhile simply shows the card, and closing the sheet drops the
 * query so a reload does not reopen it.
 * </p>
 */
type Open = { kind: "record" } | { kind: "edit" } | { kind: "confirm"; mode: ConfirmMode } | null;

export function ResultCard({ bookingId }: { bookingId: string }) {
  const read = useResult(bookingId);
  const [chosen, setChosen] = useState<Open>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const open = chosen ?? deepLinked(params.get("result"), read.data);
  const close = () => {
    setChosen(null);
    if (params.has("result")) {
      const next = new URLSearchParams(params);
      next.delete("result");
      setParams(next, { replace: true });
    }
  };
  const done = (result: MatchResult, text: string) => {
    close();
    setNotice(text);
    read.adopt(result);
  };
  // 404 is an answer: this viewer is not a player of the booking (an admin looking in), and a
  // result is only ever shown to its players (§3.4). Nothing to say, so the card is not drawn.
  // `result_not_found` is the one 404 that means something else — the booking is one the viewer played
  // and simply has no result — so it reads as "no result yet", never as a hidden card.
  if (!read.data && read.error instanceof ApiError && read.error.status === 404) {
    if (read.error.code !== "result_not_found") return null;
    return <NoResultYet />;
  }
  return (
    <Section title={RESULT_CARD.title} description={RESULT_CARD.description} data-result-card="">
      <StateBlock
        loading={!read.data && read.loading}
        error={read.data ? null : read.error}
        action={RESULT_CARD.readAction}
        codes={PLAY_REFUSAL}
        onRetry={read.reload}
        skeleton={<CardSkeleton />}
      >
        {read.data ? <CardBody view={read.data} read={read} choose={setChosen} say={setNotice} /> : null}
      </StateBlock>
      <ConfirmGone param={params.get("result")} view={read.data} />
      <p aria-live="polite" className="sr-only">{notice ?? ""}</p>
      {notice ? <Alert tone="success" live="off" data-result-notice="">{notice}</Alert> : null}
      {read.data ? <Sheets view={read.data} open={open} close={close} done={done} stale={read.reload} /> : null}
    </Section>
  );
}

function deepLinked(param: string | null, view: BookingResultView | null): Open {
  if (!view) return null;
  if (param === "record" && view.permissions.can_record) return { kind: "record" };
  if (param === "confirm" && view.result?.status === "pending" && view.permissions.can_confirm) {
    return { kind: "confirm", mode: "confirm" };
  }
  return null;
}

type SheetsProps = {
  view: BookingResultView;
  open: Open;
  close: () => void;
  done: (result: MatchResult, text: string) => void;
  stale: () => void;
};

function Sheets({ view, open, close, done, stale }: SheetsProps) {
  const result = view.result;
  return (
    <>
      <ResultSheet
        open={open?.kind === "record" || open?.kind === "edit"}
        onOpenChange={(next) => { if (!next) close(); }}
        view={view}
        editing={open?.kind === "edit" ? result : null}
        onDone={(r) => done(r, open?.kind === "edit" ? RESULT_SHEET.saved : RESULT_SHEET.recorded)}
        onStale={stale}
      />
      {result ? (
        <ConfirmResultSheet
          open={open?.kind === "confirm"}
          onOpenChange={(next) => { if (!next) close(); }}
          result={result}
          initialMode={open?.kind === "confirm" ? open.mode : "confirm"}
          onDone={(r, mode) => done(r, mode === "confirm" ? CONFIRM_SHEET.confirmed : CONFIRM_SHEET.disputed)}
          onStale={stale}
        />
      ) : null}
    </>
  );
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4" aria-hidden="true">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-16" />
      <Skeleton className="h-touch w-40" />
    </div>
  );
}

type BodyProps = {
  view: BookingResultView;
  read: ResultRead;
  choose: (open: Open) => void;
  say: (text: string) => void;
};

function CardBody({ view, read, choose, say }: BodyProps) {
  const result = view.result;
  return (
    <div data-result-status={result?.status ?? "none"} className="flex flex-col gap-4 rounded-xl border border-border bg-bg-surface p-4 sm:p-6">
      {result ? <Summary result={result} /> : <Nothing view={view} />}
      <Actions view={view} read={read} choose={choose} say={say} />
    </div>
  );
}

function Nothing({ view }: { view: BookingResultView }) {
  const why = notRecordableLine(view.not_recordable_reason);
  if (view.permissions.can_record) {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-semibold text-text-primary">{RESULT_CARD.noneYet}</p>
        <p className="text-text-secondary">{RESULT_CARD.noneYetHint}</p>
        {view.record_closes_at ? <p className="text-text-secondary">{RESULT_CARD.recordUntil(playWhen(view.record_closes_at))}</p> : null}
      </div>
    );
  }
  return <p className="text-sm text-text-secondary">{why ?? RESULT_CARD.noneYet}</p>;
}

function Summary({ result }: { result: MatchResult }) {
  const auth = useAuth();
  const you = auth.status === "authenticated" ? auth.userId : null;
  const outcome = outcomeLine(result);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[result.status]}>{statusHeadline(result)}</Badge>
        <span className="text-xs text-text-secondary">{FORMAT_LABEL[result.format]}</span>
      </div>
      {result.status === "voided" || result.status === "withdrawn" ? null : <ResultScore result={result} you={you} />}
      {outcome && result.status === "confirmed" ? <p className="text-sm font-semibold text-text-primary">{outcome}</p> : null}
      <StatusLines result={result} />
    </div>
  );
}

function statusHeadline(result: MatchResult): string {
  switch (result.status) {
    case "pending": return STATUS_WORD.pending;
    case "confirmed": return result.auto_confirmed ? RESULT_CARD.confirmedAuto : RESULT_CARD.confirmed;
    case "disputed": return RESULT_CARD.disputed;
    case "voided": return RESULT_CARD.voided;
    default: return RESULT_CARD.withdrawnStatus;
  }
}

/** R2 F2-5 — the card speaks to its viewer: "Waiting for you to confirm", "You said this isn't right". */
function statusLines(result: MatchResult, me: string | null): string[] {
  const lines: string[] = [];
  if (result.status === "pending") {
    const due = result.confirm_due_at ? playWhen(result.confirm_due_at) : null;
    lines.push(RESULT_CARD.waitingFor(confirmingNames(result, me), due));
  }
  if (result.status === "disputed" && result.disputed_by) {
    lines.push(isViewer(result.disputed_by, me) ? RESULT_CARD.disputedByYou : RESULT_CARD.disputedBy(result.disputed_by.name));
  }
  if (result.status === "confirmed" && result.confirmed_by) {
    lines.push(isViewer(result.confirmed_by, me) ? RESULT_CARD.confirmedByYou : RESULT_CARD.confirmedBy(result.confirmed_by.name));
  }
  const when = playWhen(result.edited_at ?? result.submitted_at);
  lines.push(isViewer(result.submitted_by, me) ? RESULT_CARD.recordedByYou(when) : RESULT_CARD.recordedBy(result.submitted_by.name, when));
  return lines;
}

function StatusLines({ result }: { result: MatchResult }) {
  const auth = useAuth();
  const lines = statusLines(result, auth.status === "authenticated" ? auth.userId : null);
  return (
    <div className="flex flex-col gap-1 text-sm text-text-secondary">
      {lines.map((line) => <p key={line}>{line}</p>)}
      {result.status === "disputed" && result.dispute_note ? (
        <blockquote data-dispute-note="" className="border-l-2 border-warning-strong pl-3 text-text-primary">{result.dispute_note}</blockquote>
      ) : null}
    </div>
  );
}

function Actions({ view, read, choose, say }: BodyProps) {
  const { permissions, result } = view;
  const confirm = useAsyncAction(() => playEndpoints.confirm(view.booking_id, result?.version ?? 0), {
    success: (answer) => { say(CONFIRM_SHEET.confirmed); read.adopt(answer); },
    failure: () => read.reload(),
  });
  const any = permissions.can_record || permissions.can_confirm || permissions.can_dispute || permissions.can_edit || permissions.can_withdraw;
  if (!any) return null;
  return (
    <div className="flex flex-col gap-3">
      {permissions.can_confirm ? <p className="text-sm font-medium text-text-primary">{RESULT_CARD.waitingForYou}</p> : null}
      {confirm.error ? <Alert tone="danger" live="assertive">{playRefusal(confirm.error, RESULT_CARD.action)}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {permissions.can_record ? <Button onClick={() => choose({ kind: "record" })}>{RESULT_CARD.record}</Button> : null}
        {permissions.can_confirm ? <Button pending={confirm.pending} onClick={() => void confirm.run()}>{RESULT_CARD.confirm}</Button> : null}
        {permissions.can_dispute ? (
          <Button variant="outline" onClick={() => choose({ kind: "confirm", mode: "dispute" })}>{RESULT_CARD.somethingWrong}</Button>
        ) : null}
        {permissions.can_edit ? <Button variant="outline" onClick={() => choose({ kind: "edit" })}>{RESULT_CARD.edit}</Button> : null}
        {permissions.can_withdraw && result ? <Withdraw result={result} read={read} say={say} /> : null}
      </div>
    </div>
  );
}

function Withdraw({ result, read, say }: { result: MatchResult; read: ResultRead; say: (text: string) => void }) {
  return (
    <ConfirmDialog
      trigger={<Button variant="danger-soft">{RESULT_CARD.withdraw}</Button>}
      title={RESULT_CARD.withdrawTitle}
      description={RESULT_CARD.withdrawBody}
      confirmLabel={RESULT_CARD.withdraw}
      cancelLabel={RESULT_CARD.withdrawKeep}
      action={RESULT_CARD.action}
      codes={PLAY_REFUSAL}
      onConfirm={async () => {
        try {
          const answer = await playEndpoints.withdraw(result.booking_id, result.version);
          say(RESULT_CARD.withdrawn);
          read.adopt(answer);
        } catch (error) {
          read.reload();
          throw error;
        }
      }}
    />
  );
}

function NoResultYet() {
  return (
    <Section title={RESULT_CARD.title} description={RESULT_CARD.description} data-result-card="">
      <p data-result-status="none" className="text-sm text-text-secondary">{RESULT_CARD.noneYet}</p>
    </Section>
  );
}

/**
 * The mail's "Is it right?" link, opened once the result is no longer waiting on this viewer
 * (R1 F2.11): say what happened, so an old inbox line is never read as a question still open.
 * Pending on somebody else (the viewer recorded it) is not "gone" — the card says who it waits on.
 */
function ConfirmGone({ param, view }: { param: string | null; view: BookingResultView | null }) {
  if (param !== "confirm" || !view || view.result?.status === "pending") return null;
  return <Alert tone="info" live="polite" data-result-gone="">{RESULT_CARD.confirmGone(view.result?.status ?? null)}</Alert>;
}
