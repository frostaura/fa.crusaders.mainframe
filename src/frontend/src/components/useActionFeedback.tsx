import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatedAlert, AnimatedCheck } from "./ui/feedback-marks";
import { Spinner } from "./ui/spinner";
import { motion } from "../lib/tokens";

/**
 * Item 12 — the one response every confirm, decline, save and cancel in the product makes.
 *
 * <p>
 * <b>The decision, in one sentence.</b> Every affirmative and negative action gets the same
 * four phases — rest → press → working → outcome — implemented once, carried by a mark and a
 * colour as well as by motion, and never configured at a call site.
 * </p>
 *
 * <p>
 * <b>No glyph at rest (R8 / D5).</b> A button at rest is its word. Working is a spinner; a success is the hand-drawn `AnimatedCheck`; a failure
 * is `AnimatedAlert` plus the shake — `components/ui/feedback-marks.tsx`.
 * </p>
 *
 * <p>
 * <b>What it is not.</b> It is not an announcer. It sets <code>data-fb</code>, returns class
 * names and draws an <code>aria-hidden</code> glyph, and it renders no live region of any kind.
 * This codebase has paid for the opposite twice: a toast announced twice because the viewport
 * carried <code>aria-live</code> <em>and</em> each toast carried <code>role="status"</code>
 * (`Toast.tsx:62-74`), and <code>getByRole("status")</code> finding eleven regions on the doors
 * overview (`ConfirmButton.tsx:635-639`). The announcement stays where it already is:
 * `ConfirmButton`'s single polite region, the `Toast`, or — for a `Button` with an intent and
 * neither of those — one polite region the `Button` itself renders, once.
 * </p>
 *
 * <p>
 * <b>Reduced motion removes the motion and keeps everything else.</b> The colour change, the
 * glyph swap and the full {@link motion.duration.hold} survive, because they are not motion —
 * they are what the feedback actually is. The block in `index.css` that stands
 * <code>[data-fb]</code> down is animation and transform only, deliberately.
 * </p>
 */

/**
 * What an action MEANS. Four, not three, and the fourth is ruling 4's.
 *
 * <ul>
 *   <li><b>neutral</b> — today's look, exactly. No glyph, no outcome phase. The default, so
 *       that every one of the hundred-odd existing `Button` call sites is untouched.</li>
 *   <li><b>affirm</b> — Book, Save, Continue. A tick when the work lands.</li>
 *   <li><b>decline</b> — Cancel, the way out of an armed pair. A tick when the work lands too:
 *       the mark says "that happened", not "yes".</li>
 *   <li><b>destructive</b> — Delete, Shut, Revoke. <b>Never celebrates.</b> A tick bursting over
 *       a deletion reads as the software enjoying itself; the action keeps its own icon — a bin,
 *       a lock — and the danger treatment it already has, and settles to muted: see
 *       {@link outcomeClassName}. A failure still shows the alert mark.</li>
 * </ul>
 */
export type ActionIntent = "affirm" | "decline" | "neutral" | "destructive";

export type FeedbackPhase = "rest" | "press" | "working" | "success" | "failure";

const msOf = (value: string) => Number.parseInt(value, 10);

/** The mark a phase wears. There is none at rest or on the press — R8 retired the thumbs. */
export type FeedbackMarkKind = "working" | "success" | "failure";

/**
 * Which mark a phase wears, or none. `null` means "draw whatever the caller already draws".
 *
 * <p>
 * Rest and press are always `null`: a button at rest is its word (R8). A destructive success is
 * `null` too — the bin stays a bin and nothing celebrates a deletion — but a destructive failure
 * still says so. `neutral` wears nothing at any phase, so the hundred-odd bare call sites are
 * untouched.
 * </p>
 */
export function glyphKindFor(intent: ActionIntent, phase: FeedbackPhase): FeedbackMarkKind | null {
  if (intent === "neutral") return null;
  if (phase === "failure") return "failure";
  if (phase === "working") return "working";
  if (phase === "success" && intent !== "destructive") return "success";
  return null;
}

/** The node for a mark. A switch, not a lookup of components — see `glyph` on {@link ActionFeedback}. */
function markFor(kind: FeedbackMarkKind | null): React.ReactNode {
  if (kind === "working") return <Spinner />;
  if (kind === "success") return <AnimatedCheck size={16} />;
  if (kind === "failure") return <AnimatedAlert size={16} />;
  return null;
}

/**
 * What the button looks like once the work has landed.
 *
 * <p>
 * <b>A destructive success is a fade, not a flourish.</b> No pop, no scale, and it settles to
 * the muted pair rather than to green. Deleting a thing you meant to delete is a relief, not a
 * win; green means <em>good outcome</em>, and the good outcome here is that nothing surprising
 * happened. A tick bursting over a deletion reads as the software enjoying itself.
 * </p>
 */
export function outcomeClassName(intent: ActionIntent, phase: FeedbackPhase): string {
  if (phase === "failure") {
    return "bg-danger-soft text-danger-strong animate-fb-shake motion-reduce:animate-none";
  }
  if (phase !== "success") return "";
  if (intent === "destructive") return "bg-bg-muted text-text-secondary transition-colors duration-settle";
  return "bg-success-soft text-success-strong transition-colors duration-in ease-out";
}

/**
 * The press.
 *
 * <p>
 * The affordance layer in `index.css` already takes the 1 px hover lift away on
 * <code>:active</code>; this adds the compression that makes a tap feel <em>landed</em>. A
 * destructive button gets neither the scale nor the speed — it settles rather than snapping,
 * because a button that shuts a door should not feel eager.
 * </p>
 */
export function pressClassName(intent: ActionIntent, phase: FeedbackPhase): string {
  if (phase !== "press") return "";
  if (intent === "destructive") return "transition-transform duration-settle ease-standard";
  return "scale-[0.97] transition-transform duration-press ease-in";
}

/**
 * What happened, as a value rather than as a thrown thing.
 *
 * <p>
 * <b>Why not "resolve means it worked".</b> A great many actions in this product resolve to
 * `undefined` — `onConfirm: () => Promise<void>` is the commonest shape there is — so a `run`
 * that returned `T | undefined` would hand a caller the same answer for "it worked and said
 * nothing" and "it failed". `ConfirmButton` would then announce "Done." over a refusal, which
 * is worse than the unhandled rejection it replaced.
 * </p>
 */
export type ActionOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export type ActionFeedback = {
  phase: FeedbackPhase;
  /**
   * Wrap the work. Resolve → success, reject → failure.
   *
   * <b>It never rethrows.</b> The returned {@link ActionOutcome} is the report. A rejection
   * escaping an `onClick` is an unhandled rejection, which in this product means a console
   * error nobody sees and a button left looking as though it did nothing.
   */
  run: <T>(work: () => T | Promise<T>) => Promise<ActionOutcome<T>>;
  /** Spread onto the button. Carries `data-fb`, `data-intent` and the press handler. */
  props: {
    "data-fb": FeedbackPhase;
    "data-intent": ActionIntent;
    onPointerDown: () => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
  /** The phase's classes, for the caller to compose with its own. */
  className: string;
  /**
   * The mark for the current phase, already `aria-hidden`, or null — a spinner while working,
   * `AnimatedCheck` on success, `AnimatedAlert` on failure, nothing at rest.
   *
   * A NODE, not a component. Returning `Glyph: () => …` reads better at the call site and is
   * a component created during render — a form the `react-hooks` rule refuses, because a
   * component identity that changes between renders remounts its subtree. A node has no
   * identity to change.
   */
  glyph: React.ReactNode;
};

export function useActionFeedback(intent: ActionIntent): ActionFeedback {
  const [phase, setPhase] = useState<FeedbackPhase>("rest");
  /**
   * Set on mount as well as cleared on unmount.
   *
   * Without the assignment this only ever writes `false`, and React's development double
   * invoke runs mount → cleanup → mount — so it is false from the first render onwards. That
   * exact bug left a confirm button stuck on "Working…" after a successful booking and the
   * founder reported it; `ConfirmButton` carries the same paragraph for the same reason.
   */
  const mounted = useRef(true);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const t of timers.current) window.clearTimeout(t);
      timers.current = [];
    };
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(() => { if (mounted.current) fn(); }, ms));
  }, []);

  const press = useCallback(() => {
    // Only from rest. A pointer landing on a button that is already working must not reset it
    // to a press state, which would take the spinner away under the finger.
    setPhase((current) => (current === "rest" ? "press" : current));
    /*
     * And it releases ITSELF after the press duration, rather than waiting for a pointerup
     * that may never come.
     *
     * <p>
     * The case is not hypothetical and it is the commonest one in this product: pressing
     * `ConfirmButton`'s trigger arms the control, which unmounts the trigger before the finger
     * comes back up. A press state that only ever ends on `pointerup` would leave that button
     * compressed for as long as it exists. 90 ms is the compression's own duration, so the
     * timer and the transition finish together.
     * </p>
     */
    later(() => setPhase((current) => (current === "press" ? "rest" : current)), msOf(motion.duration.press));
  }, [later]);

  const release = useCallback(() => {
    setPhase((current) => (current === "press" ? "rest" : current));
  }, []);

  const run = useCallback(async <T,>(work: () => T | Promise<T>): Promise<ActionOutcome<T>> => {
    setPhase("working");
    try {
      const value = await Promise.resolve(work());
      if (mounted.current) {
        setPhase("success");
        // The hold is READING TIME, and it is the one number in this spec outside M3's band.
        // It is kept in full under reduced motion, because it is not motion.
        later(() => setPhase("rest"), msOf(motion.duration.hold));
      }
      return { ok: true, value };
    } catch (error) {
      // Swallowed on purpose — see `run` on {@link ActionFeedback}. The caller that needs the
      // error gets it back in the outcome; this is the visual half of the report.
      if (mounted.current) {
        setPhase("failure");
        later(() => setPhase("rest"), msOf(motion.duration.hold));
      }
      return { ok: false, error };
    }
  }, [later]);

  const glyph = markFor(glyphKindFor(intent, phase));

  return {
    phase,
    run,
    props: {
      "data-fb": phase,
      "data-intent": intent,
      onPointerDown: press,
      onPointerUp: release,
      onPointerCancel: release,
    },
    className: `${pressClassName(intent, phase)} ${outcomeClassName(intent, phase)}`.trim(),
    glyph,
  };
}
