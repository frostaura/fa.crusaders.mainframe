import { Alert, type AlertTone } from "@/components/Alert";
import { useToast, type ToastTone } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { AnimatedAlert, AnimatedCheck } from "@/components/ui/feedback-marks";
import { CalendarBlank } from "@/components/ui/icons";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StateBlock } from "@/components/ui/state-block";
import { AsyncDemo } from "./AsyncDemo";
import { Demo, Specimen, ThemePair } from "./parts";

/** Skeletons, marks, alerts, progress, the four read states, toasts and the async posture. */

const TONES: readonly AlertTone[] = ["info", "success", "warning", "danger"];

const ALERT_TEXT: Record<AlertTone, string> = {
  info: "Courts 3 and 4 close at 20:00 on Friday for league night.",
  success: "Your top-up of 100 cr has landed.",
  warning: "Your balance is below one session. Top up before you book.",
  danger: "That slot was taken a moment ago. Nothing was charged.",
};

function Marks() {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <Specimen label="spinner"><Spinner className="size-5" /></Specimen>
      <Specimen label="check"><AnimatedCheck animate={false} className="text-success-strong" /></Specimen>
      <Specimen label="alert"><AnimatedAlert animate={false} className="text-danger-strong" /></Specimen>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-surface p-4">
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

function StaticFeedback() {
  return (
    <div className="flex flex-col gap-5">
      <Marks />
      <CardSkeleton />
      <div className="flex flex-col gap-2">
        {TONES.map((tone) => <Alert key={tone} tone={tone} live="off">{ALERT_TEXT[tone]}</Alert>)}
      </div>
      <div className="flex flex-col gap-2">
        <Progress value={3} max={8} aria-label="Bookings made" />
        <p className="text-xs text-text-secondary tabular-nums">3 of 8 booked</p>
        <Progress value={null} aria-label="Reading the ledger" />
      </div>
    </div>
  );
}

function ReadStates() {
  return (
    <div className="flex flex-col gap-5">
      <StateBlock loading action="read the bookings" skeleton={<CardSkeleton />} />
      <StateBlock
        empty
        emptyIcon={CalendarBlank}
        emptyTitle="No bookings yet"
        emptyHint="Pick a court on the grid to book your first session."
        emptyAction={<Button variant="secondary" size="sm">Book a court</Button>}
      />
      <StateBlock error={new Error("demo")} action="read the fault list" onRetry={() => undefined} />
      <StateBlock stale readAt="18:02" staleHint="The club system has not answered since.">
        <p className="text-sm text-text-primary">Court 2 is lit until 19:00.</p>
      </StateBlock>
    </div>
  );
}

const TOAST_TEXT: Record<ToastTone, string> = {
  info: "Court 4 is back in use.",
  success: "Booked Court 2 at 18:00.",
  warning: "Your balance is low.",
  danger: "Could not cancel that booking.",
};

function ToastButtons() {
  const { push } = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(TOAST_TEXT) as ToastTone[]).map((tone) => (
        <Button key={tone} variant="outline" size="sm" onClick={() => push({ tone, text: TOAST_TEXT[tone] })}>
          {`Toast: ${tone}`}
        </Button>
      ))}
    </div>
  );
}

export function FeedbackSection() {
  return (
    <div className="flex flex-col gap-10">
      <Demo title="Marks, skeleton, alerts, progress" note="Alerts here are live off, so the gallery does not talk over itself.">
        <ThemePair>{() => <StaticFeedback />}</ThemePair>
      </Demo>
      <Demo title="Read states" note="StateBlock: loading as a skeleton, empty with a next step, failed with a retry, stale with a time.">
        <ThemePair>{() => <ReadStates />}</ThemePair>
      </Demo>
      <Demo title="Toasts" note="The toast strip is page-level, so it follows the page theme.">
        <ToastButtons />
      </Demo>
      <Demo title="Async action" note="useAsyncAction with the network replaced by your hands. Re-entry is ignored; the failure stays until the next run.">
        <AsyncDemo />
      </Demo>
    </div>
  );
}
