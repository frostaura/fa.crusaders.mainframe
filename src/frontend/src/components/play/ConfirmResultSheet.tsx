import { useState } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { errorCode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { playEndpoints, type MatchResult } from "@/lib/playApi";
import { UnsureOutcome } from "@/lib/lostReply";
import { CONFIRM_SHEET, FORMAT_LABEL, NOTE_MAX, playRefusal, playWhen, RESULT_CARD, RESULT_UNSURE } from "@/lib/playCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { landedAs, resultWrite } from "./resultReadBack";
import { ResultScore } from "./ResultScore";

/**
 * The confirming side's answer (§9.2): the score read-only, `Confirm result`, or `Something's
 * wrong` — which opens an optional note for the club and `Send to the club`. The mail's link
 * (`?result=confirm`) lands here.
 *
 * <p>
 * Both answers name the version the member was SHOWN (`expectedVersion`): if the submitter
 * edited the score while this sheet was open, the server answers `result_changed` and the
 * member is shown the new score rather than confirming one they never saw.
 * </p>
 */
export type ConfirmMode = "confirm" | "dispute";

export type ConfirmResultSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: MatchResult;
  /** Open straight at the note ("Something's wrong" on the card). */
  initialMode?: ConfirmMode;
  /** `proven` — the reply was lost and the result was read back (R3 I-1). */
  onDone: (result: MatchResult, mode: ConfirmMode, proven: boolean) => void;
  onStale: () => void;
};

export function ConfirmResultSheet(props: ConfirmResultSheetProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <ConfirmBody {...props} /> : null}
    </Dialog>
  );
}

const STALE = new Set(["result_changed", "result_not_pending"]);

function useConfirmFlow(props: ConfirmResultSheetProps) {
  const { result, onDone, onStale } = props;
  const auth = useAuth();
  const me = auth.status === "authenticated" ? auth.userId : null;
  const [mode, setMode] = useState<ConfirmMode>(props.initialMode ?? "confirm");
  const [note, setNote] = useState("");
  const failure = (error: unknown) => { if (error instanceof UnsureOutcome || STALE.has(errorCode(error) ?? "")) onStale(); };
  const bookingId = result.booking_id;
  const confirm = useAsyncAction(
    () => resultWrite(bookingId, () => playEndpoints.confirm(bookingId, result.version), landedAs.confirmed(result)),
    { success: (landed) => onDone(landed.value, "confirm", landed.proven), failure },
  );
  const dispute = useAsyncAction(
    () => resultWrite(bookingId, () => playEndpoints.dispute(bookingId, result.version, note.trim() || undefined), landedAs.disputed(result, me)),
    { success: (landed) => onDone(landed.value, "dispute", landed.proven), failure },
  );
  return { mode, setMode, note, setNote, confirm, dispute };
}

function ConfirmBody(props: ConfirmResultSheetProps) {
  const flow = useConfirmFlow(props);
  const auth = useAuth();
  const { result } = props;
  const error = flow.mode === "confirm" ? flow.confirm.error : flow.dispute.error;
  return (
    <DialogContent data-dialog="confirm-result">
      <DialogHeader>
        <DialogTitle>{CONFIRM_SHEET.title}</DialogTitle>
        <DialogDescription>{CONFIRM_SHEET.description}</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <div className="rounded-xl border border-border bg-bg-surface p-3">
          <ResultScore result={result} you={auth.status === "authenticated" ? auth.userId : null} />
          <p className="mt-2 text-xs text-text-secondary">
            {`${FORMAT_LABEL[result.format]} · ${RESULT_CARD.recordedBy(result.submitted_by.name, playWhen(result.submitted_at))}`}
          </p>
        </div>
        {flow.mode === "dispute" ? <NoteField note={flow.note} onChange={flow.setNote} /> : null}
        {error ? (
          <Alert tone="danger" live="assertive">
            {playRefusal(error, CONFIRM_SHEET.action, flow.mode === "confirm" ? RESULT_UNSURE.confirm : RESULT_UNSURE.dispute)}
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {flow.mode === "confirm" ? (
          <>
            <Button variant="outline" onClick={() => flow.setMode("dispute")}>{CONFIRM_SHEET.somethingWrong}</Button>
            <Button pending={flow.confirm.pending} onClick={() => void flow.confirm.run()}>{CONFIRM_SHEET.confirm}</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => flow.setMode("confirm")}>{CONFIRM_SHEET.back}</Button>
            <Button pending={flow.dispute.pending} onClick={() => void flow.dispute.run()}>{CONFIRM_SHEET.send}</Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

function NoteField({ note, onChange }: { note: string; onChange: (note: string) => void }) {
  return (
    <Field controlId="dispute-note">
      <FieldLabel>{CONFIRM_SHEET.noteLabel}</FieldLabel>
      <Textarea rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => onChange(e.target.value)} />
      <FieldDescription>{`${note.length} / ${NOTE_MAX}`}</FieldDescription>
    </Field>
  );
}
