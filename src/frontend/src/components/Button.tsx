import { type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/utils";
import { ACTION_FAILED_ANNOUNCEMENT, useActionFeedback, type ActionIntent } from "./useActionFeedback";

export type Variant = "default" | "primary" | "ghost" | "danger" | "outline";

/**
 * What each variant looks like — hoisted out of the component, and exported. (C8)
 *
 * <p>
 * It was a `Record` rebuilt inside every render, which cost nothing and hid something: there
 * was no way to ask the question "does every variant carry a boundary?" without rendering one
 * button per variant and hoping the list of variants in the test still matched the list in the
 * component. Reviewer C found `ghost` with no border at all under forced colours, and a test
 * that enumerates a hand-written list would have missed it exactly as a reader did.
 * </p>
 *
 * <p>
 * Exported so that `e2e/confirm-armed.spec.ts` can put a real button of every variant on a real
 * page under `forced-colors: active` and measure the border the browser computes — the class
 * strings come from here rather than being copied, so a sixth variant is measured the day it is
 * added and a variant that drops its border fails rather than being quietly skipped.
 * </p>
 */
export const BUTTON_VARIANT_CLASS: Record<Variant, string> = {
  default: "bg-info-soft text-info-strong border border-info-soft hover:bg-info-soft/70",
    /**
     * A real filled primary, for the one action a screen exists for.
     *
     * `default` is deliberately NOT redefined to this. There are dozens of bare `<Button>` call
     * sites across the admin console, and changing the default restyles every one of them
     * unreviewed. docs/specs/design-system.md does say the default variant should use the
     * accent — so `default: bg-info-soft` is in breach of the project's own spec — but that
     * migration is its own change, not something to smuggle in behind a login screen.
     *
     * `hover:bg-brand-strong/90` compiles because brand.strong is literal hex. The identical
     * utility on `accent.strong` emits nothing at all; see the accent block in tailwind.config.
     */
  primary: "bg-brand-strong text-brand-ink border border-brand-strong hover:bg-brand-strong/90",
  /**
   * C8 — `border border-transparent`, on the one variant that had no boundary at all.
   *
   * Under `forced-colors: active` every author background goes, so a ghost button is
   * left as bare text with no edge and nothing to say it can be pressed. A transparent
   * 1 px border costs nothing in ordinary rendering — it is already in the box model,
   * so nothing moves when the `forced-colors` block in index.css gives it a system
   * colour — and it is what stops this variant collapsing into a paragraph. The other
   * four variants already declare a border; this is the one that did not.
   */
  ghost: "bg-transparent border border-transparent text-text-secondary hover:bg-bg-muted",
  // `border-control`: an outline button's boundary IS the button — there is no fill to see
  // it by — so SC 1.4.11's 3:1 applies to it more plainly than to anything else here.
  outline: "border border-control bg-bg-surface hover:bg-bg-muted",
  danger: "bg-danger-soft text-danger-strong border border-danger-soft hover:bg-danger-soft/70",
};

/**
 * Item 12's additions. <b>Every one of them is optional, and the defaults are today exactly.</b>
 *
 * <p>
 * There are over a hundred bare `<Button>` call sites in this product across four lanes
 * editing in parallel. A theme that restyled any of them unreviewed would be the
 * `default: bg-info-soft` mistake again — see the note on {@link BUTTON_VARIANT_CLASS}. So
 * `intent` defaults to `"neutral"`, which renders byte-identical classes to the button before
 * this change, and `action-feedback.test.tsx` asserts that rather than trusting it.
 * </p>
 */
export type ActionButtonProps = {
  /**
   * Draws the glyph and turns the feedback theme on. `"neutral"` is today's look, exactly.
   *
   * `"destructive"` is the one that matters for a bin or a lock: it never draws a thumb, it
   * does not celebrate, and its press settles rather than snapping. See `useActionFeedback`.
   */
  intent?: ActionIntent;
  /**
   * Wraps the work, so the outcome phase means something.
   *
   * <p>
   * Omit it and `onClick` behaves exactly as it does now, with no outcome phase — which is
   * right for a button that navigates or opens a dialog, where "it worked" is the next screen
   * appearing. Supply it and a resolve reaches `success`, a reject reaches `failure`, and
   * neither escapes to the console.
   * </p>
   *
   * <p>
   * Runs INSTEAD of `onClick`, not as well as it: a call site that passes both would do its
   * work twice, which on a money endpoint is a double charge. Passing both is a type error
   * nowhere, so it is stated here and asserted in the test.
   * </p>
   */
  onAction?: () => void | Promise<unknown>;
  /**
   * What a screen reader hears when `onAction` succeeds. Required when there is nothing else.
   *
   * <p>
   * A visual success a blind member never learns about is not a success. Where the action
   * already raises a `Toast`, or where the button lives inside a `ConfirmButton`'s own polite
   * region, the announcement exists and this must be left out — two regions saying one fact is
   * the defect `Toast.tsx:62-74` records. Where neither is true, this is the region, and the
   * hook below refuses the outcome phase in development without it.
   * </p>
   */
  feedbackAnnouncement?: string;
  /** What it says on failure. Defaults to {@link ACTION_FAILED_ANNOUNCEMENT}. */
  failureAnnouncement?: string;
  /**
   * Set where something ELSE announces the outcome — a toast, an enclosing `ConfirmButton`.
   *
   * It is opt-in and never inferred: "an announcement exists" is a fact only the call site
   * knows, and guessing it wrong is silence in one direction and a double announcement in the
   * other.
   */
  announcedElsewhere?: boolean;
};

export function Button({
  className, variant = "default", loading, disabled, children,
  intent = "neutral", onAction, feedbackAnnouncement, failureAnnouncement, announcedElsewhere,
  onClick, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean } & ActionButtonProps) {
  const feedback = useActionFeedback(intent);
  const themed = intent !== "neutral";

  /**
   * A silent visual success, refused at the one moment it can still be fixed.
   *
   * <p>
   * In development only, and only for a button that has an intent AND does work AND names no
   * announcer of any kind. It cannot fire on any existing call site — `intent` is new and
   * defaults to neutral — so this is a guard on the code being written now, which is when a
   * missing announcement is a one-line fix rather than an accessibility finding in a review.
   * </p>
   */
  if (import.meta.env.DEV && themed && onAction && !feedbackAnnouncement && !announcedElsewhere) {
    throw new Error(
      "Button: intent + onAction with no `feedbackAnnouncement` and no `announcedElsewhere`. " +
      "A visual-only outcome is a success a blind member is never told about. Pass the sentence, " +
      "or set announcedElsewhere when a Toast or a ConfirmButton already says it.",
    );
  }

  const announcement = feedback.phase === "success"
    ? feedbackAnnouncement
    : feedback.phase === "failure"
      ? (failureAnnouncement ?? ACTION_FAILED_ANNOUNCEMENT)
      : "";

  // The hover lift, the pressed state, the cursor and the focus ring all come from the
  // base layer in index.css, which keys on the element rather than on this component —
  // so a control built without reaching for `Button` still feels like the rest of the
  // product. That was the point of the finding: the fingerprint control on the schedule
  // had a real affordance and nothing else did, so which things could be pressed was
  // something a member learned screen by screen. Only what is specific to this button
  // belongs here.
  return (
    <button
      disabled={disabled || loading}
      aria-busy={loading || feedback.phase === "working" || undefined}
      onClick={onAction ? () => { void feedback.run(onAction); } : onClick}
      /*
        `data-fb` and the press handlers, only for a themed button.
        <p>
        A neutral button must be byte-identical to what it was, and an extra attribute on the
        element is not byte-identical: `e2e/feedback-theme.spec.ts` counts `[data-fb]` nodes to
        prove the theme reaches every acting control, and a hundred neutral buttons carrying
        the attribute would make that count meaningless.
        </p>
      */
      {...(themed ? feedback.props : {})}
      className={cn(
        /*
          B12, applied to the primitive itself — the box in PIXELS, the text in rem.

          `h-11 px-5` is 44 px and 20 px a side at a 16 px root font size, and 88 px and 40 px
          at a 32 px one: a button twice as tall as a fingertip needs, with 80 px of horizontal
          padding inside it, on a 320 px screen. Measured on /schedule and /my-code, that is
          most of why the page scrolled sideways at large text. `ConfirmButton` already solved
          this for its own control and records the arithmetic at length; this is the same fix
          on the primitive every other screen reaches for.

          `min-h`, not `h`: a fixed height cannot contain its own words once they wrap, which
          is the other half of what `withoutFixedHeight` exists to strip off call sites. The
          TEXT still scales — that is what a root font size is for — and the box around it
          stops growing at the size a fingertip needs.
        */
        /*
         * `min-w-0 break-words` — the horizontal half of the same rule the height above is
         * the vertical half of.
         *
         * A button's default automatic minimum size is its longest WORD, and it has no way
         * to give that back: at a 32 px root font on a 320 px phone, "Edit buttons" wants
         * 145 px inside a 124 px column and "Box activity" 140 px, so the button pushed its
         * own row sideways and every ancestor with it. Measured on the Devices page, where
         * the shell's and the card's rem padding already leave about 124 px to work in.
         *
         * `min-w-0` lets it shrink and `break-words` makes the label wrap rather than spill
         * once it has. Neither does anything at an ordinary text size — a button wide enough
         * for its words is untouched — and the 44 px floor above is unaffected, so a label
         * that takes two lines gets a taller control rather than a clipped one.
         */
        "inline-flex items-center justify-center gap-2 min-w-0 max-w-full break-words min-h-[44px] px-[20px] py-[8px] rounded-lg text-sm font-medium",
        BUTTON_VARIANT_CLASS[variant],
        // The disabled LOOK is suppressed while loading, but `disabled` itself is kept — it is
        // what stops a double submit, which on register means uploading the photo twice. A
        // button that greys out the moment you press it reads as "that broke", which is the
        // opposite of what is happening.
        loading ? "disabled:opacity-100 disabled:cursor-progress" : "disabled:opacity-50",
        themed && feedback.className,
        className
      )}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current motion-reduce:animate-none"
        />
      )}
      {themed && feedback.glyph}
      {children}
      {/* ONE polite region, and only where this button is the only thing that could speak.
          `aria-live` without `role="status"`, exactly as `ConfirmButton` settles it: the role
          is the same live region plus a landmark, and a screen of these would put a dozen
          empty status landmarks in the accessibility tree. */}
      {themed && !announcedElsewhere && (feedbackAnnouncement || failureAnnouncement) && (
        <span aria-live="polite" className="sr-only">{announcement}</span>
      )}
    </button>
  );
}

/**
 * What a control that a person types into or picks from looks like.
 *
 * <p>
 * Exported, because this exact string was written out at twelve sites across nine files — every
 * bare `<input type="date">` and every native `<select>` that did not reach for `Input`. Two
 * consequences, and the second is the one that mattered. It drifted: some copies carried
 * `text-text-primary`, some did not, one carried a focus ring the rest lacked. And it carried
 * `border-border` — <b>1.23:1</b> against the white behind it, where WCAG 2.1 SC 1.4.11 asks
 * 3:1 for the boundary of a user-interface component. An empty text field has nothing but its
 * outline to say it is a field; at 1.23:1 there was, for a good many people, no field there.
 * Twelve places to fix that one at a time, or one.
 * </p>
 *
 * <p>
 * `border-control`, not `border-border`: a card edge and a text field have different jobs and
 * only one of them is a control. See `control` in lib/tokens.ts.
 * </p>
 */
/**
 * <b>No `focus:outline-none` (B8), and the reason is measured rather than argued.</b>
 *
 * <p>
 * Reviewer B tabbed through the door log's three filter selects and reported no visible
 * focus indication at all, with a screenshot of a focused select and an unfocused one that
 * are pixel-identical. Two things were true at once, and only one of them was guessed:
 * </p>
 *
 * <ol>
 *   <li>`focus:outline-none` compiles to <code>outline: 2px solid transparent</code> at
 *       (0,2,0), which beats this product's house focus rule — the <code>:focus-visible</code>
 *       block in `index.css`, at (0,1,0) — so a field opted out of the one focus indicator
 *       every other control in the product has, and got a FLUSH ring instead of the offset
 *       outline, which against an existing 1 px border reads as a slightly thicker border.</li>
 *   <li>The replacement ring is a `box-shadow`, and `index.css`'s base layer puts `select` in
 *       the set that transitions `box-shadow` over 200 ms. Measured in Chromium on the built
 *       stylesheet: at t=0 after focus the computed box-shadow is
 *       <code>rgba(0,0,0,0) 0 0 0 0</code> three times over, and only at t=600 ms is it
 *       <code>rgb(0,73,141) 0 0 0 2px</code>. The outline is not in that transition list, so
 *       it is the half that was instant — and it was the half that had been switched off.</li>
 * </ol>
 *
 * <p>
 * Dropping `outline-none` restores the offset, instant, product-wide indicator and keeps the
 * ring as a second cue. Same probe after the change: <code>outline: rgb(0,73,141) 2px
 * solid</code> immediately on focus.
 * </p>
 */
export const fieldClassName = cn(
  "w-full h-11 px-3 rounded-lg border border-control bg-bg-surface text-text-primary placeholder:text-text-muted",
  "focus:ring-2 focus:ring-accent-strong focus:border-accent-strong",
);

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClassName, className)} {...props} />;
}

/**
 * The native select, wearing the same clothes as {@link Input}.
 *
 * A `<select>` was hand-rolled at every one of its eleven call sites, which is why some of them
 * had a focus ring and some did not.
 */
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldClassName, className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-sm font-medium text-text-secondary mb-1", className)} {...props} />;
}

export function Badge({ tone = "muted", children }: { tone?: "muted" | "success" | "info" | "warning" | "danger"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    muted: "bg-bg-muted text-text-secondary",
    success: "bg-success-soft text-success-strong",
    info: "bg-info-soft text-info-strong",
    warning: "bg-warning-soft text-warning-strong",
    danger: "bg-danger-soft text-danger-strong",
  };
  // `min-w-0 break-words` for the same reason the button above carries them: a pill holds
  // whatever copy a call site gives it, and "New — check court numbers" wants 134 px inside
  // the 124 px a 32 px root font leaves on this estate's narrowest screen. A badge that
  // cannot shrink below its longest word takes the row it sits in with it.
  return <span className={cn("inline-flex items-center min-w-0 max-w-full break-words px-2.5 py-0.5 rounded-full text-xs font-medium", tones[tone])}>{children}</span>;
}
