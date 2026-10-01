import { useState } from "react";
import type { PurchaseStatus } from "../lib/api";
import { Button } from "../components/ui/button";
import { Panel } from "../components/ui/card";
import { Alert } from "../components/Alert";
import { useAsyncAction } from "../lib/useAsyncAction";
import {
  OPEN_CHECKOUTS, cancelFailedSentence, cancelOpenCheckout, cancelledSentence, checkoutWhat, type CancelResult, type OpenCheckout,
} from "../lib/topUpOpen";

type Said = { tone: "success" | "danger"; text: string };

/**
 * M5-2 — the member's purchases still waiting on PayFast, each with its own Cancel (P13 §3.4:
 * `open_checkouts` on the shelf read). Below the shelf, so a member who left PayFast without
 * paying can close it themselves instead of waiting out the hour.
 *
 * <p>
 * <b>Optimistic, because it is safe.</b> A pressed row leaves the list at once; a cancel that
 * fails (refused, offline, or a lost reply the club's record could not settle) puts it back and
 * says why. Whatever the cancel ended in, the shelf is then re-read (`onChanged`), so the list
 * shows what the club holds, never what this screen assumed — a payment that went through after
 * all is said as such, with its minutes.
 * </p>
 */
export function OpenCheckouts({ open, onChanged }: { open: OpenCheckout[]; onChanged: () => void }) {
  const [said, setSaid] = useState<Said | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const shown = open.filter((c) => !hidden.has(c.id));
  if (shown.length === 0 && !said) return null;
  const hide = (id: string, gone: boolean) => setHidden((h) => {
    const next = new Set(h);
    if (gone) next.add(id); else next.delete(id);
    return next;
  });
  return (
    <Panel role="region" aria-labelledby="topup-open-title" className="flex flex-col gap-4" data-open-checkouts="">
      <div className="flex flex-col gap-1">
        <h2 id="topup-open-title" className="text-base font-semibold text-text-primary">{OPEN_CHECKOUTS.title}</h2>
        {shown.length > 0 ? <p className="text-sm text-text-secondary">{OPEN_CHECKOUTS.help}</p> : null}
      </div>
      {shown.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {shown.map((c) => (
            <OpenRow
              key={c.id}
              checkout={c}
              onHide={(gone) => hide(c.id, gone)}
              onSaid={(next) => { setSaid(next); onChanged(); }}
            />
          ))}
        </ul>
      )}
      {said && <Alert tone={said.tone} live="polite">{said.text}</Alert>}
    </Panel>
  );
}

function OpenRow({ checkout, onHide, onSaid }: { checkout: OpenCheckout; onHide: (gone: boolean) => void; onSaid: (said: Said) => void }) {
  const cancel = useAsyncAction(() => cancelOpenCheckout(checkout.id), {
    optimistic: { apply: () => onHide(true), rollback: () => onHide(false) },
    success: (result: CancelResult) => onSaid({ tone: "success", text: cancelledSentence(result) }),
    failure: (error: unknown) => onSaid({ tone: "danger", text: cancelFailedSentence(error) }),
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3" data-open-checkout={checkout.id}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-base font-semibold text-text-primary [overflow-wrap:anywhere]">{checkoutWhat(checkout)}</span>
        <span className="text-sm text-text-secondary">{OPEN_CHECKOUTS.line(checkout.created_at)}</span>
        <span className="text-xs text-text-muted">{OPEN_CHECKOUTS.expires(checkout.expires_at)}</span>
      </div>
      <Button variant="outline" pending={cancel.pending} onClick={() => void cancel.run()} aria-label={OPEN_CHECKOUTS.cancelLabel(checkout)}>
        {OPEN_CHECKOUTS.cancel}
      </Button>
    </li>
  );
}

/**
 * M5-2 — the status page's Pending state offers Cancel too: a member who came back from PayFast
 * without paying (by Back, not PayFast's own Cancel) had only "Check again" and "View wallet".
 * The club's answer replaces the snapshot (`onSettled`), so the page shows Cancelled — or done,
 * when the money moved after all.
 */
export function CancelPending({ status, onSettled }: { status: PurchaseStatus; onSettled: (next: PurchaseStatus) => void }) {
  const [said, setSaid] = useState<Said | null>(null);
  const cancel = useAsyncAction(() => cancelOpenCheckout(status.id), {
    success: (result: CancelResult) => {
      setSaid({ tone: "success", text: cancelledSentence(result) });
      onSettled(result.status);
    },
    failure: (error: unknown) => setSaid({ tone: "danger", text: cancelFailedSentence(error) }),
  });
  return (
    <>
      <p className="text-sm text-text-secondary">{OPEN_CHECKOUTS.line(status.created_at)}</p>
      <div>
        <Button variant="outline" pending={cancel.pending} onClick={() => void cancel.run()}>{OPEN_CHECKOUTS.statusCancel}</Button>
      </div>
      {said && <Alert tone={said.tone} live="polite">{said.text}</Alert>}
    </>
  );
}
