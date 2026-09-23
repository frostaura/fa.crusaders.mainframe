import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { describeFailure } from "./errors";
import { motion } from "./tokens";

/**
 * The one posture every mutation in the product takes (design-system.md, Patterns → Async
 * actions): pending → success | error, re-entry ignored, errors returned as outcomes rather than
 * thrown, optional optimistic apply/rollback, and an optional toast through the existing
 * `Toast` system.
 *
 * <p>
 * <b>Why not `disabled={busy}`.</b> A disabled button drops focus to `<body>` the instant the
 * work starts, and a screen reader loses its place. A button reads `pending` and renders
 * `aria-busy` + `aria-disabled` instead, and a second tap lands on {@link AsyncAction.run},
 * which ignores it — so a double tap can never book a court twice.
 * </p>
 *
 * <p>
 * <b>`run` never throws.</b> A rejection escaping an `onClick` is an unhandled rejection: a
 * console error nobody sees and a button that looks as though it did nothing. The returned
 * {@link AsyncOutcome} is the report; `error` holds the same value for rendering.
 * </p>
 *
 * <p>
 * <b>Success holds, error stays.</b> `success` is reading time — it returns to `idle` after
 * `motion.duration.hold` (1 200 ms), kept in full under reduced motion because it is not motion.
 * `error` stays until the next `run` or {@link AsyncAction.reset}, because the failure sentence a
 * page renders from it must not vanish while somebody is still reading it.
 * </p>
 */
export type AsyncStatus = "idle" | "pending" | "success" | "error";

/** What happened. `skipped` is true when the call was ignored because one was already in flight. */
export type AsyncOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown; skipped: boolean };

export type AsyncToast<T> = {
  /** Toast on success — only when given. Most successes speak through the button's own mark. */
  success?: string | ((value: T) => string);
  /** Toast on failure. Defaults to `describeFailure(error, { action, codes })`. */
  failure?: string | ((error: unknown) => string);
  /** `describeFailure`'s verb phrase: "book the court" → "Couldn't book the court — …". */
  action?: string;
  codes?: Record<string, string>;
  /** Add "Nothing changed." — only when the caller KNOWS the write did not land (see Toast). */
  unchanged?: boolean;
};

export type AsyncActionOptions<A extends unknown[], T> = {
  success?: (value: T, ...args: A) => void;
  failure?: (error: unknown, ...args: A) => void;
  /** Applied before `fn` runs; rolled back if it fails. The optimistic half of a toggle or a book. */
  optimistic?: { apply: (...args: A) => void; rollback: (...args: A) => void };
  toast?: AsyncToast<T>;
};

export type AsyncAction<A extends unknown[], T> = {
  run: (...args: A) => Promise<AsyncOutcome<T>>;
  pending: boolean;
  status: AsyncStatus;
  error: unknown;
  /** Back to idle, clearing any error. Does not cancel work in flight. */
  reset: () => void;
};

type Push = ReturnType<typeof useToast>["push"];
type State = { status: AsyncStatus; error: unknown };

const IDLE: State = { status: "idle", error: null };
const SKIPPED = { ok: false, error: undefined, skipped: true } as const;
const HOLD_MS = Number.parseInt(motion.duration.hold, 10);

/** The toast push when a `ToastProvider` is above us; null when not (a bare unit test). */
function useOptionalPush(): Push | null {
  try {
    return useToast().push;
  } catch {
    return null;
  }
}

/** A caller's callback must not turn a finished outcome into a thrown one. */
function safely(callback: () => void) {
  try {
    callback();
  } catch (error) {
    console.error(error);
  }
}

function toastText<V>(text: string | ((value: V) => string), value: V): string {
  return typeof text === "function" ? text(value) : text;
}

function toastSuccess<T>(push: Push | null, toast: AsyncToast<T> | undefined, value: T) {
  if (!push || !toast?.success) return;
  push({ tone: "success", text: toastText(toast.success, value) });
}

function toastFailure<T>(push: Push | null, toast: AsyncToast<T> | undefined, error: unknown) {
  if (!push || !toast) return;
  const text = toast.failure
    ? toastText(toast.failure, error)
    : describeFailure(error, { action: toast.action, codes: toast.codes });
  push({ tone: "danger", text, unchanged: toast.unchanged });
}

export function useAsyncAction<A extends unknown[], T>(
  fn: (...args: A) => T | Promise<T>,
  options: AsyncActionOptions<A, T> = {},
): AsyncAction<A, T> {
  const [state, setState] = useState<State>(IDLE);
  const push = useOptionalPush();
  const latest = useRef({ fn, options, push });
  const inFlight = useRef(false);
  // Set on mount as well as cleared on unmount: StrictMode runs mount → cleanup → mount, and a
  // ref only ever written `false` is false from the first click (ConfirmButton's stuck
  // "Working…" defect).
  const mounted = useRef(false);
  const holdTimer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    latest.current = { fn, options, push };
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(holdTimer.current);
    };
  }, []);

  const settle = useCallback((next: State) => {
    if (mounted.current) setState(next);
  }, []);

  const succeed = useCallback((value: T, args: A) => {
    const { options: opts, push: toastPush } = latest.current;
    settle({ status: "success", error: null });
    holdTimer.current = window.setTimeout(() => settle(IDLE), HOLD_MS);
    if (opts.success) safely(() => opts.success?.(value, ...args));
    toastSuccess(toastPush, opts.toast, value);
  }, [settle]);

  const fail = useCallback((error: unknown, args: A) => {
    const { options: opts, push: toastPush } = latest.current;
    if (opts.optimistic) safely(() => opts.optimistic?.rollback(...args));
    settle({ status: "error", error });
    if (opts.failure) safely(() => opts.failure?.(error, ...args));
    toastFailure(toastPush, opts.toast, error);
  }, [settle]);

  const run = useCallback(async (...args: A): Promise<AsyncOutcome<T>> => {
    if (inFlight.current) return SKIPPED;
    inFlight.current = true;
    window.clearTimeout(holdTimer.current);
    settle({ status: "pending", error: null });
    try {
      const { fn: work, options: opts } = latest.current;
      opts.optimistic?.apply(...args);
      const value = await work(...args);
      succeed(value, args);
      return { ok: true, value };
    } catch (error) {
      fail(error, args);
      return { ok: false, error, skipped: false };
    } finally {
      inFlight.current = false;
    }
  }, [settle, succeed, fail]);

  const reset = useCallback(() => {
    window.clearTimeout(holdTimer.current);
    settle(IDLE);
  }, [settle]);

  return { run, pending: state.status === "pending", status: state.status, error: state.error, reset };
}
