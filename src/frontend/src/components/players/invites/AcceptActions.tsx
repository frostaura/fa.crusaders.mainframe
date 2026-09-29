import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { INVITES_COPY, acceptLabel } from "@/lib/playersCopy";
import type { AcceptFlow } from "./useAcceptFlow";

/**
 * Accept · Decline · the way out — and, once Decline is pressed, its confirmation (it is final). Source order is dismiss first, primary last, so the dialog
 * footer's `flex-col-reverse` puts Accept on top on a phone and on the right on a desktop.
 *
 * <p>
 * An Accept that cannot be pressed is `aria-disabled` with the reason as its description,
 * never `disabled` — it stays focusable, so a screen reader reaches it and hears why.
 * </p>
 */
export function AcceptActions({ flow, reasonId, dismiss }: { flow: AcceptFlow; reasonId: string; dismiss: ReactNode }) {
  if (flow.outcome) return <>{dismiss}</>;
  // R1 F2.6 — one question at a time: "decline for good?" replaces the three buttons until answered.
  if (flow.askingDecline) {
    return (
      <>
        <Button variant="outline" onClick={flow.keepInvite}>{INVITES_COPY.declineKeep}</Button>
        <Button variant="danger" onClick={flow.confirmDecline} data-decline-confirm="">{INVITES_COPY.declineConfirm}</Button>
      </>
    );
  }
  return (
    <>
      {dismiss}
      {flow.canDecline ? (
        <Button variant="outline" pending={flow.declineAction.pending} onClick={flow.decline} data-decline="">
          {INVITES_COPY.decline}
        </Button>
      ) : null}
      <AcceptButton flow={flow} reasonId={reasonId} />
    </>
  );
}

function AcceptButton({ flow, reasonId }: { flow: AcceptFlow; reasonId: string }) {
  const label = acceptLabel(flow.money.toPay);
  if (flow.blocked) {
    return (
      <Button aria-disabled="true" aria-describedby={reasonId} data-unavailable="" className="cursor-not-allowed opacity-50 hover:bg-primary">
        {label}
      </Button>
    );
  }
  return (
    <Button pending={flow.acceptAction.pending} onClick={flow.accept} data-accept="">
      {label}
    </Button>
  );
}
