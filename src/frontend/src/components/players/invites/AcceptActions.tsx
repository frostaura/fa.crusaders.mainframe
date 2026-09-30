import { useLayoutEffect, useRef, type ReactNode } from "react";
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
  if (flow.askingDecline) return <ConfirmDecline flow={flow} />;
  return (
    <>
      {dismiss}
      {flow.canDecline ? <DeclineButton flow={flow} /> : null}
      <AcceptButton flow={flow} reasonId={reasonId} />
    </>
  );
}

/** Focus a button as it mounts — when `when` holds. Layout, so no frame paints with focus on <body>. */
function useFocusOnMount(when: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  // Mount only: the question is asked (or answered) once per appearance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (when) ref.current?.focus(); }, []);
  return ref;
}

/**
 * R2 F2-10 — the question opens with focus on the SAFE answer. It used to sit where Decline had
 * been, on "Decline for good", so a second Enter declined for good.
 */
function ConfirmDecline({ flow }: { flow: AcceptFlow }) {
  const keep = useFocusOnMount(true);
  return (
    <>
      <Button ref={keep} variant="outline" onClick={flow.keepInvite} data-decline-keep="">{INVITES_COPY.declineKeep}</Button>
      <Button variant="danger" onClick={flow.confirmDecline} data-decline-confirm="">{INVITES_COPY.declineConfirm}</Button>
    </>
  );
}

/** Kept the invite: focus comes back to Decline, where the member was — never to <body>. */
function DeclineButton({ flow }: { flow: AcceptFlow }) {
  const ref = useFocusOnMount(flow.keptInvite);
  return (
    <Button ref={ref} variant="outline" pending={flow.declineAction.pending} onClick={flow.decline} data-decline="">
      {INVITES_COPY.decline}
    </Button>
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
