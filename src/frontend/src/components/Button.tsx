import {
  Children, isValidElement,
  type ButtonHTMLAttributes, type LabelHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
} from "react";
import { cn } from "../lib/utils";
import { Button as UiButton, buttonVariants } from "./ui/button";
import { fieldSurface } from "./ui/input";
import { FieldLabel } from "./ui/field";
import { Badge as UiBadge } from "./ui/badge";
import { ACTION_FAILED_ANNOUNCEMENT, useActionFeedback, type ActionIntent, type FeedbackPhase } from "./useActionFeedback";

/**
 * The COMPAT SHIM over `components/ui/button.tsx` (design-system.md, Components → button).
 *
 * <p>
 * About seventy files import `Button`, `Input`, `Select`, `Label`, `Badge`, `fieldClassName` and
 * `BUTTON_VARIANT_CLASS` from here. This file keeps every one of those names and props compiling
 * and behaving, and renders through the new primitives, so each screen is migrated to `ui/*` on
 * its own schedule rather than all at once. It is deleted in the hardening phase (P10).
 * </p>
 *
 * <p>
 * <b>The variant map.</b> `default` → `secondary` (the tonal accent button the spec calls the
 * default), `primary` → `primary`, `ghost` → `ghost`, `outline` → `outline`, `danger` → `danger`.
 * `loading` (and an explicit `aria-busy`) is the new `pending`: spinner, width locked, `aria-busy` + `aria-disabled` — NOT
 * `disabled`, so focus stays on the button — and clicks are ignored while it is set, which is
 * what stopped a double submit before (a form's implicit Enter submission is a click too).
 * </p>
 */
export type Variant = "default" | "primary" | "ghost" | "danger" | "outline";

type UiVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";

const VARIANT_MAP: Record<Variant, UiVariant> = {
  default: "secondary",
  primary: "primary",
  ghost: "ghost",
  outline: "outline",
  danger: "danger",
};

/**
 * What each variant looks like — DERIVED from `buttonVariants`, never copied. (C8)
 *
 * <p>
 * Exported so `e2e/confirm-armed.spec.ts` can put a real button of every variant on a page under
 * `forced-colors: active` and measure the border the browser computes, and so a nav CTA
 * (`ScheduleNotices`) can wear a variant on a `Link`. Every entry carries the primitive's
 * `border border-transparent`, so no variant reflows when forced colours paints its edge.
 * </p>
 */
export const BUTTON_VARIANT_CLASS = Object.fromEntries(
  (Object.keys(VARIANT_MAP) as Variant[]).map((variant) => [variant, buttonVariants({ variant: VARIANT_MAP[variant] })]),
) as Record<Variant, string>;

/**
 * B12, kept: the box in PIXELS, and a label that WRAPS rather than widening the page.
 *
 * <p>
 * The primitive is a fixed 44px, no-wrap control with rem padding — right for the new screens,
 * which are laid out for it. The estate's screens were measured at a 32px root font on a 320px
 * phone, where "Edit buttons" wanted 145px inside a 124px column: rem padding doubles with the
 * text and a no-wrap label pushes the whole row sideways. So through the shim:
 * </p>
 * <ul>
 *   <li>the height is a floor, not a size (`!h-auto` — `cn` cannot resolve our named `h-touch`
 *       against `h-auto`, so the override has to win outright) and the label breaks;</li>
 *   <li>the padding is 16px / 8px in pixels, so a 32px root makes the button about 58px tall
 *       rather than 74 (`e2e/large-text.spec.ts` holds it under 1.6× the 16px height);</li>
 *   <li>the primitive's pending layer (spinner + label, kept in the same grid cell to lock the
 *       width) is NOT laid out at rest — {@link RESTING}. Reserving the spinner's room on every
 *       estate button costs 24px at a 16px root and 48px at 32px, which is exactly the overflow
 *       `e2e/admin-devices.spec.ts` measures. The width may grow when work starts, as it did
 *       before the primitive existed; screens built on `ui/button` directly keep the lock.</li>
 * </ul>
 */
const COMPAT_LAYOUT = "!h-auto min-w-0 max-w-full whitespace-normal break-words px-[16px] py-[8px] text-center";

/** At rest the pending layer takes no room (see {@link COMPAT_LAYOUT}); it is laid out while working. */
const RESTING = "[&_[data-slot=button-pending]]:hidden";

/**
 * Item 12's additions. <b>Every one of them is optional, and the defaults are the plain button.</b>
 */
export type ActionButtonProps = {
  /**
   * Turns the feedback theme on. `"neutral"` (the default) is the plain button.
   *
   * <p>
   * No glyph at rest for any intent (R8). While `onAction` runs the button shows the spinner;
   * a success shows `AnimatedCheck`, a failure `AnimatedAlert` and the shake. `"destructive"`
   * never celebrates: no tick, and it settles to muted. See `useActionFeedback`.
   * </p>
   */
  intent?: ActionIntent;
  /**
   * Wraps the work, so the outcome phase means something. Runs INSTEAD of `onClick`, not as well
   * as it: a call site that passes both would do its work twice, which on a money endpoint is a
   * double charge. A second press while it is working is ignored.
   */
  onAction?: () => void | Promise<unknown>;
  /**
   * What a screen reader hears when `onAction` succeeds. Required when nothing else announces
   * it — a visual success a blind member never learns about is not a success. Leave it out where
   * a `Toast` or an enclosing `ConfirmButton` already says it (and set `announcedElsewhere`).
   */
  feedbackAnnouncement?: string;
  /** What it says on failure. Defaults to {@link ACTION_FAILED_ANNOUNCEMENT}. */
  failureAnnouncement?: string;
  /** Set where something ELSE announces the outcome. Opt-in and never inferred. */
  announcedElsewhere?: boolean;
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean } & ActionButtonProps;

/**
 * A silent visual success, refused at the one moment it can still be fixed — in development
 * only, and only for a button that has an intent AND does work AND names no announcer.
 */
function assertAnnounced(props: ButtonProps) {
  const themed = (props.intent ?? "neutral") !== "neutral";
  if (!import.meta.env.DEV || !themed || !props.onAction) return;
  if (props.feedbackAnnouncement || props.announcedElsewhere) return;
  throw new Error(
    "Button: intent + onAction with no `feedbackAnnouncement` and no `announcedElsewhere`. " +
    "A visual-only outcome is a success a blind member is never told about. Pass the sentence, " +
    "or set announcedElsewhere when a Toast or a ConfirmButton already says it.",
  );
}

function announcementFor(phase: FeedbackPhase, said?: string, failed?: string): string {
  if (phase === "success") return said ?? "";
  if (phase === "failure") return failed ?? ACTION_FAILED_ANNOUNCEMENT;
  return "";
}

/**
 * Working, in any of the three ways a call site says it: `loading`, the feedback theme's own
 * working phase, or an explicit `aria-busy` (the doors log, the outage retry). The primitive
 * owns `aria-busy` and sets it from `pending` alone, so a call site's `aria-busy={true}` has to
 * become `pending` here or it would silently vanish. At rest the attribute is absent, which
 * means the same as `"false"`.
 */
function isPending(props: ButtonProps, phase: FeedbackPhase): boolean {
  const busy = props["aria-busy"];
  return Boolean(props.loading) || busy === true || busy === "true" || phase === "working";
}

type SplitLabel = { icon?: ReactNode; label: ReactNode };

/**
 * The label as the primitive wants it: one string, and a leading icon passed as `icon`.
 *
 * <p>
 * The primitive repeats a PLAIN-TEXT label in its width-locking pending layer as CSS content,
 * and clones any other label (aria-hidden) — so `Book for {price}`, which React hands over as an
 * array of strings, would put the words in the DOM twice and every `getByText` on it would find
 * two. Strings are joined into one; a leading icon element followed by text becomes the `icon`
 * (which the spinner replaces while working, as the spec asks). Anything else passes through.
 * </p>
 */
function splitLabel(children: ReactNode): SplitLabel {
  if (!Array.isArray(children)) return { label: children };
  const parts = Children.toArray(children);
  const textual = (part: unknown) => typeof part === "string" || typeof part === "number";
  if (parts.every(textual)) return { label: parts.join("") };
  const [first, ...rest] = parts;
  if (isValidElement(first) && rest.length > 0 && rest.every(textual)) {
    return { icon: first, label: rest.join("").trim() };
  }
  return { label: children };
}

export function Button(allProps: ButtonProps) {
  // Destructured in the body: lizard counts every destructured prop as a parameter (gate: 6).
  const {
    className, variant = "default", loading: _loading, children, intent = "neutral", onAction,
    feedbackAnnouncement, failureAnnouncement, announcedElsewhere, onClick, ...props
  } = allProps;
  const feedback = useActionFeedback(intent);
  const themed = intent !== "neutral";
  assertAnnounced(allProps);

  const outcome = feedback.phase === "success" || feedback.phase === "failure" ? feedback.glyph : null;
  const { icon, label } = splitLabel(children);
  const speaks = themed && !announcedElsewhere && Boolean(feedbackAnnouncement || failureAnnouncement);

  const pending = isPending(allProps, feedback.phase);
  const button = (
    <UiButton
      variant={VARIANT_MAP[variant]}
      pending={pending}
      icon={outcome ?? icon}
      onClick={onAction ? () => { void feedback.run(onAction); } : onClick}
      /* `data-fb` and the press handlers only on a themed button: `e2e/feedback-theme.spec.ts`
         counts `[data-fb]` nodes to prove the theme reaches every acting control. */
      {...(themed ? feedback.props : {})}
      className={cn(COMPAT_LAYOUT, !pending && RESTING, themed && feedback.className, className)}
      {...props}
    >
      {label}
    </UiButton>
  );
  if (!speaks) return button;
  /* ONE polite region, and only where this button is the only thing that could speak — beside
     the button, not inside it, so it is never part of the accessible name and the primitive's
     pending layer never clones it. `aria-live` without `role="status"`: a screen of these would
     otherwise put a dozen empty status landmarks in the tree. */
  return (
    <>
      {button}
      <span aria-live="polite" className="sr-only">{announcementFor(feedback.phase, feedbackAnnouncement, failureAnnouncement)}</span>
    </>
  );
}

/**
 * What a NATIVE control a person types into or picks from looks like — the primitive's field
 * surface at 44px. For the raw `<select>` and `<input type="date">` sites the later phases
 * migrate to `ui/select` and `ui/date-picker`.
 *
 * <p>
 * `border-control`, never `border-border`: a text field's outline is the only thing that says it
 * is a field, and SC 1.4.11 asks 3:1 for it. No `outline-none` and no ring (B8): the house
 * `:focus-visible` outline in `index.css` is the focus indicator, instant and offset.
 * </p>
 */
export const fieldClassName = cn(fieldSurface, "h-touch px-3");

/** The text input — the primitive itself (Field-aware, 16px on phones so iOS does not zoom). */
export { Input } from "./ui/input";

/** The native select, wearing the same field surface as `Input`. Migrated to `ui/select` later. */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldClassName, className)} {...props} />;
}

/** The primitive's label, as a block above its control with the spec's 6px gap. */
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <FieldLabel className={cn("mb-1.5 block", className)} {...props} />;
}

type BadgeTone = "muted" | "neutral" | "success" | "info" | "warning" | "danger" | "brand";

/**
 * The primitive's badge. `muted` is the old name for `neutral`. The label keeps its own
 * `min-w-0 break-words` span — text directly inside a flex container is an anonymous flex item
 * no selector can shrink (memory/gotchas-frontend.md).
 */
export function Badge({ tone = "muted", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <UiBadge tone={tone === "muted" ? "neutral" : tone}>{children}</UiBadge>;
}
