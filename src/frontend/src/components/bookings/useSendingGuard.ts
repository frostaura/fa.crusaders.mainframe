import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useToast } from "@/components/toastContext";

/**
 * R4 I4-1 — a money sheet stays open while its write is on its way.
 *
 * <p>
 * A member pressed Book on a slow reply, then Back, then Cancel (or Escape, or the ×): the sheet
 * closed without a word, the booking landed a moment later, and 50 minutes were gone with nothing
 * on screen saying so. Every way out of a sheet — its own Cancel/Back/Keep/Done, the ×, Escape,
 * the scrim and the system Back — now asks here first, and while the write is in flight the answer
 * is no: the sheet says it is waiting for the club, and says it again when somebody tries to leave.
 * </p>
 *
 * <p>
 * The one way out nothing can refuse is the sheet being torn down under it (a sign-out, a route
 * the shell forces). `useLateLanding` covers that: an answer that arrives after the sheet has gone
 * is said in a toast — a landing is never silent.
 * </p>
 */
export type SendingGuard = {
  /** The Dialog's `onOpenChange`: a close while sending is refused and announced. */
  onOpenChange: (open: boolean) => void;
  /** The flow reports whether its write is in flight. */
  setSending: (sending: boolean) => void;
  /** Bumped by every refused close — the sheet re-announces its waiting line on each. */
  refused: number;
};

export function useSendingGuard(onOpenChange: (open: boolean) => void, onBusyChange?: (busy: boolean) => void): SendingGuard {
  const sending = useRef(false);
  const [refused, setRefused] = useState(0);
  const latest = useRef({ onOpenChange, onBusyChange });
  useLayoutEffect(() => { latest.current = { onOpenChange, onBusyChange }; });
  const setSending = useCallback((next: boolean) => {
    if (sending.current === next) return;
    sending.current = next;
    latest.current.onBusyChange?.(next);
  }, []);
  const change = useCallback((open: boolean) => {
    if (!open && sending.current) {
      setRefused((n) => n + 1);
      return;
    }
    latest.current.onOpenChange(open);
  }, []);
  return { onOpenChange: change, setSending, refused };
}

/** The toast push when a provider is above us; null in a bare render. */
function useOptionalPush() {
  try {
    return useToast().push;
  } catch {
    return null;
  }
}

/**
 * Whether the sheet is still there to say an outcome itself, and a way to say it when it is not.
 * `live()` is false once the flow's view has unmounted or the sheet has been closed.
 */
export function useLateLanding(open = true) {
  const mounted = useRef(false);
  const openNow = useRef(open);
  const push = useOptionalPush();
  const pushRef = useRef(push);
  useLayoutEffect(() => {
    openNow.current = open;
    pushRef.current = push;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const live = useCallback(() => mounted.current && openNow.current, []);
  const say = useCallback((tone: "success" | "danger", text: string) => {
    pushRef.current?.({ tone, text });
  }, []);
  /** Says `text()` in a toast only when the sheet is gone — otherwise the sheet says it itself. */
  const sayIfGone = useCallback((tone: "success" | "danger", text: () => string) => {
    if (!live()) say(tone, text());
  }, [live, say]);
  return { live, say, sayIfGone };
}
