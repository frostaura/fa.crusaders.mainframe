import { Children, isValidElement, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

export type ConfirmTone = "info" | "danger";

type ConfirmButtonProps = {
  idleLabel: React.ReactNode;
  confirmLabel?: React.ReactNode;
  /** May return a Promise — the button stays armed with a spinner until it resolves. */
  onConfirm: () => void | Promise<void>;
  className?: string;
  /** Idle (resting) variant. Defaults to "info" — soft blue. */
  idleClassName?: string;
  /** Armed (confirm) variant. Defaults to a warm orange alert. */
  armedClassName?: string;
  /**
   * ms to keep the armed state before snapping back. **8000 by default.**
   *
   * <p>
   * It defaulted to 3000 once, and that silently broke the one control it most needed to
   * get right. A member who took longer than three seconds to read "Reserve for 50.00 cr?"
   * tapped a button that had already gone back to idle, so the second tap re-armed instead
   * of confirming — a slow reader could tap for ever and never book anything, with no
   * request leaving the browser and nothing on screen to explain it. The default was then
   * taken off altogether, which traded that defect for the opposite one: an armed control
   * on an admin screen in a club office stayed armed indefinitely, one tap from whoever
   * walked past next.
   * </p>
   *
   * <p>
   * <b>8000 is not a re-run of 3000.</b> Three things are different. The booking grid — the
   * control the timer broke — no longer uses this component at all. The armed control now
   * GROWS to fit its consequence at 14 px instead of clipping it to a 44 px box, so the
   * sentence can actually be read inside the window. And a visible Cancel stands beside it,
   * so leaving is a control you can see rather than a gesture you have to know. Eight
   * seconds is long enough to read a four-line consequence and short enough that an
   * abandoned screen is not left loaded.
   * </p>
   *
   * <p>
   * Escape, a click outside and a blur all still disarm, and none of them wait for a timer.
   * </p>
   */
  armedTimeoutMs?: number;
  disabled?: boolean;
  /**
   * What this button acts ON, in a sentence, for assistive tech.
   *
   * <p>
   * The visible label alone is often not a name. A list of doors is a column of controls all
   * reading "Shut this door", laid out so that WHICH door is conveyed by visual position
   * against a heading — which is nothing at all to somebody tabbing through them. Passing
   * "Shut Side door" says which one.
   * </p>
   *
   * <p>
   * <b>It is appended to the visible label, never substituted for it</b> — see
   * {@link accessibleName}. It used to replace it, which broke WCAG 2.5.3: a control reading
   * "Shut all doors" was named "Shut every door the club has open — 3 of 3", so speech
   * control could not reach it by the words on it and a screen-reader user could not tell
   * that what they heard and what they saw were the same control.
   * </p>
   */
  ariaLabel?: string;
  /**
   * What the idle button is for. `danger` is the treatment every destructive confirm in the
   * product already used; `idleClassName` still overrides it for the one-off.
   */
  tone?: ConfirmTone;
};

/**
 * What the button looks like before it is armed, by what it is about to do.
 *
 * <p>
 * The destructive string was written out at six call sites — `Profile`, `AdminSettings`,
 * `AdminDevices`, `AdminMembers`, `AdminWebhooks` and `DeviceApiKeyPanel` — which is six places
 * to miss when the treatment changes and no way to tell from any one of them that the others
 * exist. Naming it makes "this button deletes something" a choice the call site declares rather
 * than a class string it copies.
 * </p>
 */
const IDLE_BY_TONE: Record<ConfirmTone, string> = {
  info: "bg-info-soft text-info-strong hover:bg-info-soft/80",
  danger: "bg-danger-soft text-danger-strong hover:bg-danger-soft/70",
};

/**
 * The words inside a label, whatever it is made of.
 *
 * Most call sites pass a string; `Profile` passes an icon and a word in a span. The accessible
 * name has to contain the VISIBLE label verbatim (WCAG 2.5.3), so it has to be read out of the
 * node rather than assumed to be one.
 */
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  // A CAST rather than `isValidElement<{ children?: React.ReactNode }>(node)`.
  //
  // A generic type argument in expression position opens with `<{`, and lizard's lexer in a
  // .tsx file reads that as a JSX tag it then never finds the close of — so every brace
  // after it is swallowed as tag content, three functions vanish from its output and the
  // last one it does see is measured as running to the end of the file. That is what failed
  // `make complexity` on the 200-line bound: `withoutFixedHeight` reported 15 NLOC at a
  // length of 224. Same family as the bare-`<` trap recorded in `test/harness.tsx`.
  if (isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return Children.toArray(props.children).map(textOf).join("");
  }
  return "";
}

/**
 * The accessible name: what the button says, then what it acts on, then the state it is in.
 *
 * <p>
 * <b>The visible idle label is always the prefix.</b> `ariaLabel` used to be the whole name,
 * which is the WCAG 2.5.3 failure described on the prop: "Shut all doors" on screen,
 * "Shut every door the club has open — 3 of 3" to a screen reader and to speech control, and
 * nothing tying the two together. Composing them costs a little redundancy on a long control
 * and buys back the guarantee that whatever a person can read out, they can also say.
 * </p>
 *
 * <p>
 * Returns undefined when no context was given, which leaves the button named by its visible
 * text exactly as before — the visible text IS the whole name then, so label-in-name holds
 * trivially. This is opt-in, and a call site that has nothing to add adds nothing.
 * </p>
 */
function accessibleName(
  idleText: string, context: string | undefined, armed: boolean, pending: boolean,
): string | undefined {
  if (!context) return undefined;
  const base = composeName(idleText, context);
  if (pending) return `${base} — working`;
  if (armed) return `${base} — tap again to confirm`;
  return base;
}

/**
 * The visible label, then the context — unless the context already opens with the label.
 *
 * <p>
 * "Delete" with the context "Delete Front door" is already a name that begins with the words
 * on the control, and composing it would produce "Delete — Delete Front door": a stutter that
 * buys nothing, on a control a speech-control user reaches by saying "Delete" either way.
 * "Shut this door" with "Shut Side door" is the case the rule exists for — neither contains
 * the other, and it is the one that failed WCAG 2.5.3.
 * </p>
 *
 * <p>
 * The test is `startsWith`, not "contains": the requirement is that what you can read out is
 * what the name STARTS with, so a label buried in the middle of a sentence does not count.
 * </p>
 */
function composeName(idleText: string, context: string): string {
  if (!idleText) return context;
  return context.startsWith(idleText) ? context : `${idleText} — ${context}`;
}

/**
 * The caller's classes, with any FIXED height taken out of them.
 *
 * <p>
 * Every doors call site passed `h-11`, and that one class is most of B7/C6: on a 360 px phone
 * the armed fleet confirm measured `clientHeight 44, scrollHeight 106`, four lines of
 * consequence in a box built for one. Ordering cannot fix it — `min-h-11` after `h-11` does
 * not win, because they are different properties and tailwind-merge rightly keeps both, and
 * a height is not a floor.
 * </p>
 *
 * <p>
 * So the component refuses the height rather than arguing with it. `min-h-11` below then
 * governs, which also drags the `h-8` and `h-9` call sites up to a 44 px touch target. A
 * caller that wants a taller control raises `min-h-*`; nothing in the product wants a
 * shorter one, and a control that can be shorter than its own words is the defect this
 * closes.
 * </p>
 */
function withoutFixedHeight(className?: string): string | undefined {
  if (!className) return className;
  // String tests rather than regex literals: lizard's TypeScript lexer reads a `/.../` in a
  // .tsx file as division, loses its place, and swallows the rest of the file into this
  // function — it measured 14 NLOC at a LENGTH of 219 and failed `make complexity` on the
  // 200-line bound. Same family as the bare-`<` trap recorded in `test/harness.tsx`.
  return className
    .split(" ")
    .filter((token) => token !== "")
    .filter((token) => {
      // `sm:h-11` and `[&:hover]:h-11` are heights too; `min-h-11` and `max-h-11` are not.
      const utility = token.slice(token.lastIndexOf(":") + 1);
      return !utility.startsWith("h-") && !utility.startsWith("-h-");
    })
    .join(" ");
}

export function ConfirmButton({
  idleLabel,
  confirmLabel = "Tap to confirm",
  onConfirm,
  className,
  tone = "info",
  idleClassName = IDLE_BY_TONE[tone],
  armedClassName = "bg-armed-strong text-armed-ink",
  armedTimeoutMs = 8000,
  disabled = false,
  ariaLabel,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  // On the WRAPPER, not the button: the Cancel beside it is part of this control, and a
  // pointerdown on it is not a click outside.
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
  // Set on mount as well as cleared on unmount. Without the assignment this effect
  // only ever wrote `false`, and React's development double-invoke runs
  // mount → cleanup → mount — so `mounted.current` was false from the first render
  // onwards and the `finally` below never cleared `pending`. The button stuck on
  // "Working…" for ever after one successful action, in dev, on every screen that
  // uses it. It reads as a hung request and is not one.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const disarm = () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    setArmed(false);
  };

  useEffect(() => {
    // Only run idle-disarm bookkeeping when armed and NOT in flight.
    if (!armed || pending) return;
    if (armedTimeoutMs > 0) timer.current = window.setTimeout(disarm, armedTimeoutMs);
    const onDocPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) disarm();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") disarm(); };
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [armed, pending, armedTimeoutMs]);

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (disabled || pending) return;
    if (!armed) { setArmed(true); return; }
    // Stop the auto-disarm timer immediately and switch to pending visual.
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    setPending(true);
    try {
      await Promise.resolve(onConfirm());
    } finally {
      if (mounted.current) {
        setPending(false);
        setArmed(false);
      }
    }
  };

  /**
   * Focus leaving the control disarms it — unless it landed on the Cancel next to it.
   *
   * A browser moves focus on POINTERDOWN, so a press on Cancel fires this focusout before
   * the Cancel's own click. Disarming on it would unmount the Cancel mid-press and the click
   * would never land: a get-out control that does nothing when you press it.
   */
  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!armed || pending) return;
    const next = e.relatedTarget as Node | null;
    if (next && ref.current?.contains(next)) return;
    disarm();
  };

  const idleText = textOf(idleLabel);
  const showingConfirm = armed && !pending;

  return (
    <div ref={ref} onBlur={handleBlur} className={cn("min-w-0", showingConfirm && "space-y-2")}>
      <button
        type="button"
        disabled={disabled || pending}
        aria-label={accessibleName(idleText, ariaLabel, armed, pending)}
        // No `aria-pressed`. It was set to the armed flag, so a screen reader said "pressed"
        // on a control that had done nothing yet — the word for "done" used for "about to".
        // This is not a toggle either: the second press is a different action, not the off
        // half of the first, so aria-pressed="false" would be its own lie. The armed prompt
        // is ANNOUNCED instead, through the polite live region below.
        aria-busy={pending}
        onClick={handleClick}
        className={cn(
          "flex flex-col items-center justify-center rounded-md px-3 py-2 text-center text-sm font-medium",
          "transition-colors duration-200 ease-out",
          /**
           * `min-h-11`, and no `overflow-hidden`.
           *
           * Both halves of B7/C6. The control carried `overflow-hidden` and stacked all three
           * label states `absolute inset-0`, so the only thing contributing height was an
           * invisible width sentinel — the armed consequence was simply cut off, mid-sentence,
           * top and bottom. It grows now, and there is nothing left that could clip it if it
           * did not.
           */
          "min-h-11",
          // Never wider than what holds it. See the sentinel below.
          "max-w-full min-w-0",
          // The lift, the cursor and the focus ring come from the base layer in index.css;
          // this control keeps only its own colour transition. `no-lift` because a grid
          // cell that rises would shift the cells packed against it.
          "no-lift",
          // While pending we keep the armed visual instead of greying out via the disabled style.
          (armed || pending) ? armedClassName : idleClassName,
          pending && "cursor-wait",
          withoutFixedHeight(className),
        )}
      >
        {/* Width sentinel: both labels in one grid cell, so the button sizes to
            max(idleLabel, confirmLabel) intrinsic width and does not resize as it arms.

            `h-0` and clipped to itself, because it is a WIDTH sentinel and nothing else. It
            used to be the only child in normal flow, which meant it was also the only thing
            setting the control's height — so a one-line box was measured for a four-line
            consequence and the absolutely-positioned armed label was cut off inside it. The
            label on show is in flow below; this contributes width and no height at all.

            `whitespace-nowrap` here was a phone-sized bug of its own. The sentinel sized the
            button to the confirm label as ONE unbreakable line, so the Devices page's
            "Delete? The box re-registers on its next heartbeat." measured 319 px and, with
            the paddings around it, pushed the whole page to 435 px inside a 375 px phone —
            far enough that the API key's Copy button sat 23 px off the right edge, reachable
            only by a horizontal drag macOS draws no scrollbar for. The label is a sentence; a
            sentence may wrap. */}
        <span aria-hidden className="invisible grid h-0 overflow-hidden">
          <span className="col-start-1 row-start-1 flex items-center justify-center gap-2">{idleLabel}</span>
          <span className="col-start-1 row-start-1 flex items-center justify-center gap-2">{confirmLabel}</span>
        </span>
        {/* One label, in normal flow, so the control is as tall as what it is saying. */}
        <span className="flex items-center justify-center gap-2">
          {pending ? (
            <>
              {/* `motion-reduce:animate-none`: there is no global rule that stands Tailwind's
                  animations down, only the lift and the transition durations in index.css. */}
              <Loader2 className="animate-spin motion-reduce:animate-none" size={16} strokeWidth={2.5} />
              <span>Working…</span>
            </>
          ) : armed ? confirmLabel : idleLabel}
        </span>
      </button>

      {/**
        * The way out, as a control rather than as folklore.
        *
        * Escape and a click outside both disarmed before this existed, and neither is
        * discoverable: a phone has no Escape key, and "tap somewhere else" is a thing you
        * either already know or do not. On a control whose armed state is a paragraph about
        * something irreversible, the absence of a visible cancel reads as being committed.
        *
        * It has to live OUTSIDE the button — a button cannot contain a button — which is why
        * this component is a wrapper rather than a single element. The primary control keeps
        * its own name, so `getByRole("button", { name: ... })` still finds exactly it.
        *
        * <b>It is named by the visible label alone, never by the composed name.</b> "Cancel"
        * on its own, heard in a list of controls, names nothing — but `Cancel — <the whole
        * accessible name>` makes this button's name a superstring of the control's, and every
        * `getByRole("button", { name: /…/ })` in the suite then matched two elements the
        * moment the control armed. The action without the call site's context says what is
        * being cancelled and cannot swallow the name of the thing it sits beside.
        */}
      {showingConfirm && (
        <button
          type="button"
          aria-label={`Cancel — ${idleText}`}
          onClick={(e) => { e.stopPropagation(); disarm(); }}
          className="min-h-11 w-full rounded-md border border-control px-3 text-sm font-medium text-text-secondary"
        >
          Cancel
        </button>
      )}

      {/**
        * What replaced `aria-pressed`.
        *
        * Polite, because arming is something the person just did on purpose — it does not
        * interrupt. Emptied on disarm, so the region does not sit holding a consequence for
        * a control that is back at rest. It is outside the button on purpose: inside, its
        * text would join the button's own accessible name and the name would become the
        * whole paragraph.
        *
        * `aria-live` WITHOUT `role="status"`, deliberately. The role is the same live region
        * plus a landmark, and a screen full of these controls — the doors overview renders
        * one per door and two for the fleet — would carry a dozen status landmarks that are
        * empty most of the time. It also collides with the one status region a page really
        * does have: `getByRole("status")` on the doors overview started finding eleven.
        */}
      <span aria-live="polite" className="sr-only">
        {showingConfirm ? `${textOf(confirmLabel)} Choose it again to confirm, or Cancel to stop.` : ""}
      </span>
    </div>
  );
}
