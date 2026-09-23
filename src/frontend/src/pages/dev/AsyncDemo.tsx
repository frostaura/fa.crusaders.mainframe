import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { AnimatedAlert, AnimatedCheck } from "@/components/ui/feedback-marks";
import { useAsyncAction, type AsyncStatus } from "@/lib/useAsyncAction";
import { describeFailure } from "@/lib/errors";

/**
 * `useAsyncAction` with the network replaced by two buttons: start the action, then resolve or
 * reject it by hand, so every state (pending, the success hold, a failure that stays until the
 * next run) can be held on screen for as long as it takes to look at it.
 */
type Settler = { resolve: () => void; reject: (error: unknown) => void };

const ACTION = "save the demo";

function Outcome({ status, error }: { status: AsyncStatus; error: unknown }) {
  if (status === "success") {
    return <span className="inline-flex items-center gap-2 text-success-strong"><AnimatedCheck size={20} />Saved.</span>;
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-start gap-2 text-danger-strong">
        <AnimatedAlert size={20} className="mt-0.5" />
        {describeFailure(error, { action: ACTION })}
      </span>
    );
  }
  return <span className="text-text-secondary">{status === "pending" ? "Working, waiting for you to resolve or reject." : "Idle."}</span>;
}

export function AsyncDemo() {
  const settler = useRef<Settler | null>(null);
  const action = useAsyncAction(
    () => new Promise<void>((resolve, reject) => { settler.current = { resolve, reject }; }),
    { toast: { success: "Saved (demo).", action: ACTION } },
  );
  const resolve = () => settler.current?.resolve();
  const reject = () => settler.current?.reject(new Error("demo failure"));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button pending={action.pending} onClick={() => void action.run()}>Save</Button>
        <Button variant="outline" disabled={!action.pending} onClick={resolve}>Resolve</Button>
        <Button variant="danger-soft" disabled={!action.pending} onClick={reject}>Reject</Button>
      </div>
      <p role="status" data-async-status={action.status} className="min-h-touch text-sm">
        <Outcome status={action.status} error={action.error} />
      </p>
    </div>
  );
}
