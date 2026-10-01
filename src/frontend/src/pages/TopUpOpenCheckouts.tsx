import { useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Alert } from "../components/Alert";
import { formatMoney } from "../lib/utils";
import { useAsyncAction } from "../lib/useAsyncAction";
import {
  OPEN_CHECKOUTS, cancelFailedSentence, cancelOpenCheckout, cancelledSentence, type CancelResult, type OpenCheckout, type TopUpSnapshot,
} from "../lib/topUpOpen";

/**
 * M5-2 — the member's checkouts still waiting on PayFast, each with its own Cancel. Shown above the
 * form (and in place of it when they hold the whole limit), so a member who left PayFast without
 * paying can free their limit themselves instead of waiting out the hour.
 *
 * <p>
 * After every cancel, whatever it ended in, the page re-reads the options (`onChanged`): the list,
 * the limits line and the presets then show what the club holds, never what this screen assumed.
 * </p>
 */
export function OpenCheckouts({ open, onChanged }: { open: OpenCheckout[]; onChanged: () => void }) {
  const [said, setSaid] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  if (open.length === 0 && !said) return null;
  return (
    <Card className="px-4 sm:px-6" aria-labelledby="topup-open-title">
      {open.length > 0 && (
        <div className="flex flex-col gap-1">
          <h2 id="topup-open-title" className="text-base font-semibold text-text-primary">{OPEN_CHECKOUTS.title}</h2>
          <p className="text-sm text-text-secondary">{OPEN_CHECKOUTS.help}</p>
        </div>
      )}
      {open.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {open.map((c) => (
            <OpenRow key={c.id} checkout={c} onSaid={(next) => { setSaid(next); onChanged(); }} />
          ))}
        </ul>
      )}
      {said && <Alert tone={said.tone} live="polite">{said.text}</Alert>}
    </Card>
  );
}

function OpenRow({ checkout, onSaid }: { checkout: OpenCheckout; onSaid: (said: { tone: "success" | "danger"; text: string }) => void }) {
  const cancel = useAsyncAction(() => cancelOpenCheckout(checkout.id), {
    success: (result: CancelResult) => onSaid({ tone: "success", text: cancelledSentence(result, checkout.amount_zar) }),
    failure: (error: unknown) => onSaid({ tone: "danger", text: cancelFailedSentence(error) }),
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-base font-semibold tabular-nums text-text-primary">{formatMoney(checkout.amount_zar)}</span>
        <span className="text-sm text-text-secondary">{OPEN_CHECKOUTS.line(checkout.created_at)}</span>
      </div>
      <Button
        variant="outline"
        pending={cancel.pending}
        onClick={() => void cancel.run()}
        aria-label={OPEN_CHECKOUTS.cancelLabel(checkout.amount_zar, checkout.created_at)}
      >
        {OPEN_CHECKOUTS.cancel}
      </Button>
    </li>
  );
}

/**
 * M5-2 — the status page's Pending state offers Cancel too: a member who came back from PayFast
 * without paying (by Back, not PayFast's own Cancel) had only "Check again" and "View wallet",
 * and the payment held their limit for an hour. The club's answer replaces the snapshot
 * (`onSettled`), so the page shows Cancelled — or Completed, when the money moved after all.
 */
export function CancelPending({ status, onSettled }: { status: TopUpSnapshot; onSettled: (next: TopUpSnapshot) => void }) {
  const [said, setSaid] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const cancel = useAsyncAction(() => cancelOpenCheckout(status.id), {
    success: (result: CancelResult) => {
      setSaid({ tone: "success", text: cancelledSentence(result, status.amount_zar) });
      onSettled(result.status);
    },
    failure: (error: unknown) => setSaid({ tone: "danger", text: cancelFailedSentence(error) }),
  });
  return (
    <>
      {status.created_at && <p className="text-sm text-text-secondary">{OPEN_CHECKOUTS.line(status.created_at)}</p>}
      <div>
        <Button variant="outline" pending={cancel.pending} onClick={() => void cancel.run()}>{OPEN_CHECKOUTS.statusCancel}</Button>
      </div>
      {said && <Alert tone={said.tone} live="polite">{said.text}</Alert>}
    </>
  );
}
