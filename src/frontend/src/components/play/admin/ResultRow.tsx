import { useState } from "react";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { REQUIRED_MARK } from "@/lib/confirmDialogCopy";
import { playEndpoints, type AdminResult } from "@/lib/playApi";
import { Alert } from "@/components/Alert";
import { unsureSentence, writeOrReadBack } from "@/lib/lostReply";
import { ADMIN_RESULT_UNSURE, ADMIN_RESULTS, FORMAT_LABEL, PLAY_REFUSAL, playWhen, RESULT_LOST, STATUS_WORD } from "@/lib/playCopy";
import { ResultScore } from "../ResultScore";
import { STATUS_TONE } from "../resultFacts";

/**
 * One result on the admin's Match results list (§9.4): when and where, the lineup and score,
 * who recorded it, who disputed it and what they said — and the two decisions, each with a
 * required reason that goes on the change record: `Remove result` (danger; the dismiss is
 * `Keep it`) and, on a disputed row, `Keep result`.
 *
 * <p>
 * No watermark and no card affordance: a row that holds a destructive action is never dressed
 * as a tappable surface (design-system.md, the watermark's "never" list).
 * </p>
 */
export type ResultRowProps = {
  row: AdminResult;
  /** The row's decision landed: the list drops it and the badge re-reads. */
  onDecided: (row: AdminResult, text: string) => void;
};

export function ResultRow({ row, onDecided }: ResultRowProps) {
  const removable = row.status === "pending" || row.status === "disputed" || row.status === "confirmed";
  return (
    <li data-admin-result={row.result_id} data-status={row.status} className="flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-primary">{placeLine(row)}</p>
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_WORD[row.status]}</Badge>
      </div>
      <ResultScore result={row} />
      <Facts row={row} />
      {removable ? (
        <div className="flex flex-wrap gap-2">
          {row.status === "disputed" ? <Decision row={row} kind="uphold" onDecided={onDecided} /> : null}
          <Decision row={row} kind="void" onDecided={onDecided} />
        </div>
      ) : null}
    </li>
  );
}

function placeLine(row: AdminResult): string {
  const when = playWhen(row.starts_at);
  return row.court_name ? `${row.court_name} · ${when}` : when;
}

function Facts({ row }: { row: AdminResult }) {
  return (
    <div className="flex flex-col gap-1 text-sm text-text-secondary">
      <p>{`${FORMAT_LABEL[row.format]} · ${ADMIN_RESULTS.recordedBy(row.submitted_by.name)} · ${playWhen(row.submitted_at)}`}</p>
      {row.disputed_by ? <p>{ADMIN_RESULTS.disputedBy(row.disputed_by.name)}</p> : null}
      {row.dispute_note ? (
        <blockquote data-dispute-note="" className="border-l-2 border-warning-strong pl-3 text-text-primary">{row.dispute_note}</blockquote>
      ) : null}
    </div>
  );
}

type DecisionProps = { row: AdminResult; kind: "void" | "uphold"; onDecided: ResultRowProps["onDecided"] };

/**
 * Lost-reply audit (R3): the decision is read back off Match results — this row under the status
 * the decision gives it (voided, or confirmed for a kept one) — before anything is said.
 */
async function decide(row: AdminResult, voiding: boolean, text: string) {
  const status = voiding ? "voided" : "confirmed";
  return writeOrReadBack(
    () => (voiding ? playEndpoints.adminVoid(row.result_id, text) : playEndpoints.adminUphold(row.result_id, text)),
    async () => (await playEndpoints.adminResults(status)).items.find((r) => r.result_id === row.result_id && r.status === status) ?? null,
  );
}

/** The confirm step with its required reason. Both outcome-named; `Remove result` is danger. */
function Decision({ row, kind, onDecided }: DecisionProps) {
  const [reason, setReason] = useState("");
  const [lost, setLost] = useState<string | null>(null);
  const voiding = kind === "void";
  const act = async () => {
    setLost(null);
    try {
      const { value, proven } = await decide(row, voiding, reason.trim());
      const done = voiding ? ADMIN_RESULTS.removed : ADMIN_RESULTS.kept;
      onDecided(value, proven ? RESULT_LOST(done) : done);
    } catch (error) {
      // The dialog can only word a refusal: an unknown outcome closes it and is said on the row.
      const sentence = unsureSentence(error, voiding ? ADMIN_RESULT_UNSURE.void : ADMIN_RESULT_UNSURE.uphold);
      if (!sentence) throw error;
      setLost(sentence);
    }
  };
  return (
    <>
      {lost ? <Alert tone="warning" live="polite" className="basis-full" data-result-lost="">{lost}</Alert> : null}
      <ConfirmDialog
        trigger={<Button variant={voiding ? "danger-soft" : "outline"}>{voiding ? ADMIN_RESULTS.remove : ADMIN_RESULTS.keep}</Button>}
        title={voiding ? ADMIN_RESULTS.removeTitle : ADMIN_RESULTS.keepTitle}
        description={voiding ? ADMIN_RESULTS.removeBody : ADMIN_RESULTS.keepBody}
        confirmLabel={voiding ? ADMIN_RESULTS.remove : ADMIN_RESULTS.keep}
        cancelLabel={voiding ? ADMIN_RESULTS.removeKeep : ADMIN_RESULTS.keepCancel}
        tone={voiding ? "danger" : "primary"}
        action={voiding ? ADMIN_RESULTS.removeAction : ADMIN_RESULTS.keepAction}
        codes={PLAY_REFUSAL}
        onConfirm={act}
        notReady={reason.trim() === ""}
      >
        <Field controlId={`reason-${kind}-${row.result_id}`}>
          {/* Required, and said so (A11Y F3-18): pressing the primary without one names what is missing. */}
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            <FieldLabel>{ADMIN_RESULTS.reasonLabel}</FieldLabel>
            <span aria-hidden="true" className="text-sm text-text-secondary">{REQUIRED_MARK}</span>
          </span>
          <Textarea
            rows={2}
            required
            aria-required="true"
            maxLength={ADMIN_RESULTS.reasonMax}
            value={reason}
            placeholder={ADMIN_RESULTS.reasonPlaceholder}
            onChange={(e) => setReason(e.target.value)}
          />
          <FieldDescription>{ADMIN_RESULTS.reasonHint}</FieldDescription>
        </Field>
      </ConfirmDialog>
    </>
  );
}
