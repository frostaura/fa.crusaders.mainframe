import { Children, isValidElement, useContext, useEffect, useRef, useState } from "react";
import { UNSAFE_LocationContext } from "react-router-dom";
import { cn } from "../lib/utils";
import { buttonVariants } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { focusAfterAction, pageHeading } from "../lib/focusAfterAction";
import { useActionFeedback, type ActionIntent } from "./useActionFeedback";

export type ConfirmTone = "info" | "danger";

/**
 * Item 12, on the control that carries every destructive decision in the product.
 *
 * <p>
 * <b>Derived from `tone`, so no call site changes.</b> `info` is an affirm; `danger` is
 * <em>destructive</em>, not "decline" — and that distinction is ruling 4's. A thumbs-up on
 * "Delete this door" claims the software approves of the deletion. A destructive confirm keeps
 * the icon the call site already draws (a bin, a lock), keeps the danger treatment, does not
 * celebrate when it lands, and its press settles rather than snapping.
 * </p>
 */
const INTENT_BY_TONE: Record<ConfirmTone, ActionIntent> = {
  info: "affirm",
  danger: "destructive",
};

type ConfirmButtonProps = {
  idleLabel: React.ReactNode;
  /**
   * The CONSEQUENCE, in a sentence — and, since B5, a block of ordinary page text rather
   * than the label of a button.
   *
   * <p>
   * It used to be the armed control's own label, which is what made it unreadable: a 45-word
   * consequence rendered inside a control has to be sized, clipped or wrapped by the control,
   * and at 320 px with a 32 px root font that came to a 1 232 px button with its Cancel
   * 1 061 px below the fold. It is now a paragraph ABOVE two side-by-side buttons, at the
   * page's own 14 px, wrapping freely, clipped by nothing.
   * </p>
   */
  confirmLabel?: React.ReactNode;
  /**
   * What the way out says. "Cancel" unless the call site has a better word for it — the
   * doors screens say "Keep it open", which names the outcome rather than the mechanism.
   *
   * <p>
   * Additive and optional: every call site that says nothing keeps "Cancel".
   * </p>
   */
  cancelLabel?: string;
  /**
   * May return a Promise — both buttons stay up, with a spinner on the confirm, until it
   * resolves. A resolved STRING is announced as the result; anything else announces "Done."
   */
  onConfirm: () => void | string | Promise<void | string>;
  className?: string;
  /** Idle (resting) variant. Defaults to "info" — soft blue. */
  idleClassName?: string;
  /** Armed (confirm) variant. Defaults to a warm orange alert. */
  armedClassName?: string;
  /**
   * <b>Ignored. There is no timed auto-disarm.</b>
   *
   * <p>
   * It was 8 000 ms, and reviewers B and C measured what that bought: a 45-word confirm takes
   * about thirteen seconds to hear, the window was 8.07 s, there was no countdown, and the
   * control went back to idle underneath somebody who was still reading it. That is the 3 000 ms
   * defect again with a bigger number — a confirmation exists to be read, and one with a
   * stopwatch on it punishes exactly the people who read it.
   * </p>
   *
   * <p>
   * The armed state that a timer was guarding against — a loaded control left on a screen in a
   * club office — is closed by the four disarms that do not need a clock: Escape, the visible
   * Cancel, focus leaving the control group, and a route change. The prop is kept so that no
   * call site has to change to compile; passing it does nothing.
   * </p>
   *
   * @deprecated There is no timer. Remove the prop at the call site.
   */
  armedTimeoutMs?: number;
  disabled?: boolean;
  /**
   * What the action is ABOUT, as a noun: "Side door", "Carl's key", "the 2 doors still open".
   *
   * <p>
   * <b>C-M3.</b> The way out was named <code>"Keep it open — Shut this door"</code>: a control
   * whose whole job is to NOT do the thing, named after the thing, with the destructive verb
   * inside its own accessible name. Heard in a list of controls that is at best confusing and
   * at worst the wrong button. Named for the subject it becomes "Keep it open — Side door",
   * which says what is being kept and never says "shut" at all.
   * </p>
   *
   * <p>
   * Separate from {@link ariaLabel} because the two answer different questions: `ariaLabel` is
   * what the ACTION is ("Shut Side door"), and this is what it is about. Additive and optional
   * — a call site that says nothing keeps the old name, which is the trigger's label.
   * </p>
   */
  subject?: string;
  /**
   * Where focus goes once the action has finished. (R3-10)
   *
   * <p>
   * Called repeatedly for about a second after the action settles, so it may name something
   * the update has not rendered yet — the Reopen button that replaces the Shut button, the
   * status heading that now says what happened. Return `null` until it exists.
   * </p>
   *
   * <p>
   * Optional, and the default is not "nothing": a call site that says nothing lands on the
   * page's own <code>&lt;h1&gt;</code> rather than on <code>&lt;body&gt;</code>, which is what
   * reviewer C measured. It never overrides a page that moves focus itself.
   * </p>
   */
  focusAfter?: () => HTMLElement | null | undefined;
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
  /**
   * Item 12's one additive prop. Defaults from {@link tone}; no call site has to change.
   *
   * Pass it only to overrule the default — a `tone="info"` control that is really a refusal,
   * or a `tone="danger"` one that is not destructive at all.
   */
  intent?: ActionIntent;
};

/**
 * What the way OUT is about, as a noun — from whichever of the three the call site gave.
 *
 * <p>
 * <b>C-M3, and the half of it that was still open.</b> The way out was named
 * <code>"Keep it open — Shut this door"</code>: a control whose whole job is to NOT do the
 * thing, named after the thing, with the destructive verb inside its own accessible name.
 * `subject` fixed it for the call sites that pass one. The doors console passes the door's name
 * through <code>ariaLabel</code> instead — <code>"Shut Side door"</code> — and those call sites
 * fell through to the idle label and got the defect back.
 * </p>
 *
 * <p>
 * So where there is an <code>ariaLabel</code> and no <code>subject</code>, the shared leading
 * WORDS are dropped: <code>"Shut Side door"</code> against <code>"Shut this door"</code> shares
 * <code>"Shut"</code>, leaving <code>"Side door"</code> — which is exactly what
 * <code>subject</code> would have said. Word boundaries, not characters: a character-wise
 * common prefix of those two strings is <code>"Shut "</code> plus nothing useful on other
 * pairs, and half a word in an accessible name is worse than none.
 * </p>
 *
 * <p>
 * It never returns empty. Where stripping would leave nothing — the label and the context are
 * the same words — the whole context is used, and where there is no context at all the idle
 * label is, which is the behaviour every call site had before `subject` existed.
 * </p>
 */
/**
 * Run-of-whitespace, hoisted — and hoisted for a REASON, not for reuse.
 *
 * <p>
 * `split(/\s+/)` inline made lizard's JavaScript tokeniser read the `/` as the start of a
 * regex it never closed, so `confirmSubject` was reported as spanning lines 176-930 — 97 NLOC
 * and 755 lines long — and the complexity gate failed on a ten-line function. The function is
 * CCN 7 and 23 lines; the measurement was the only thing over the limit, and silencing that
 * with a whitelist entry would have frozen a number that was never real. Hoisted, the parser
 * closes it and the file reports what it is.
 * </p>
 *
 * <p>
 * No flags, deliberately: a `g` regex carries `lastIndex` between calls, and a shared one
 * would return different answers for the same string depending on who called it last.
 * </p>
 */
const RUN_OF_SPACE = /\s+/;

export function confirmSubject(subject: string | undefined, ariaLabel: string | undefined, idleText: string): string {
  if (subject) return subject;
  if (!ariaLabel) return idleText;
  const label = idleText.split(RUN_OF_SPACE).filter(Boolean);
  const context = ariaLabel.split(RUN_OF_SPACE).filter(Boolean);
  let shared = 0;
  while (shared < label.length && shared < context.length && label[shared] === context[shared]) shared += 1;
  const rest = context.slice(shared).join(" ").trim();
  return rest || ariaLabel;
}

/**
 * The primitive button's LOOK — its variant fill, ink, hover, radius, weight and forced-colours
 * edge — without its fixed height. (P3: restyled on `ui/button`.)
 *
 * <p>
 * Derived from `buttonVariants`, never copied, so a change to what "danger-soft" means reaches
 * this control too. The height is refused for the same reason a caller's is
 * ({@link withoutFixedHeight}): this control must grow round a word that wraps at a 32 px root
 * font, and `h-touch` would clip it. `min-h-11` in {@link CONTROL_CLASS} is the floor instead,
 * and the padding stays in pixels (B12) — the variant's `px-4` is overridden below it.
 * </p>
 */
function look(variant: "secondary" | "danger-soft" | "outline"): string {
  return withoutFixedHeight(buttonVariants({ variant, size: "md" })) ?? "";
}

/** The armed half: the `armed` role, filled, with the primitive's shadow — "about to", not "danger". */
const ARMED_LOOK = "bg-armed-strong text-armed-ink shadow-xs hover:bg-armed-strong/90";

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
  info: look("secondary"),
  danger: look("danger-soft"),
};

/** What the live region says when the control goes back to rest without acting. (C3) */
export const CONFIRM_CANCELLED_ANNOUNCEMENT = "Cancelled — nothing was changed.";

/** What it says when the caller's action finished and named no result of its own. (C3) */
export const CONFIRM_DONE_ANNOUNCEMENT = "Done.";

/**
 * What it says when the caller's action threw.
 *
 * <p>
 * There was no such sentence: a rejected `onConfirm` announced nothing and escaped as an
 * unhandled rejection. Both halves of the conditional now speak, and this one says the second
 * fact as well as the first — the same promise `Toast`'s `NOTHING_CHANGED` makes, because "it
 * failed" leaves somebody looking at a screen they can no longer trust.
 * </p>
 */
export const CONFIRM_FAILED_ANNOUNCEMENT = "That didn't work. Nothing was changed — you can try again.";

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
  // `make complexity` on the 200-line bound. Same family as the bare-`<` trap recorded in
  // `test/harness.tsx`.
  if (isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return Children.toArray(props.children).map(textOf).join("");
  }
  return "";
}

/**
 * The idle control's accessible name: what the button says, then what it acts on.
 *
 * <p>
 * <b>The visible idle label is always the prefix.</b> `ariaLabel` used to be the whole name,
 * which is the WCAG 2.5.3 failure described on the prop: "Shut all doors" on screen,
 * "Shut every door the club has open — 3 of 3" to a screen reader and to speech control, and
 * nothing tying the two together.
 * </p>
 *
 * <p>
 * Returns undefined when no context was given, which leaves the button named by its visible
 * text exactly as before.
 * </p>
 */
function accessibleName(idleText: string, context: string | undefined): string | undefined {
  if (!context) return undefined;
  return composeName(idleText, context);
}

/**
 * The CONFIRM button's accessible name — and why it is not simply the visible label.
 *
 * <p>
 * The confirm button shows the same words the trigger did ("Shut this door"), because the
 * consequence is now a paragraph above it rather than its label. Two buttons reading the same
 * thing one above the other would be fine on screen and useless in a list of controls, so the
 * name carries the context the call site gave AND says which of the two states it is in:
 * "Shut this door — Side door — choose again to confirm".
 * </p>
 *
 * <p>
 * Where the call site gave no context the CONSEQUENCE is the context — "Delete? The box
 * re-registers on its next heartbeat." already opens with the word on the button, so
 * {@link composeName} leaves it alone and label-in-name holds on the sentence itself.
 * </p>
 */
function confirmName(idleText: string, context: string | undefined, consequence: string): string | undefined {
  if (context) return `${composeName(idleText, context)} — ${CONFIRM_AGAIN}`;
  if (!consequence) return undefined;
  return composeName(idleText, consequence);
}

/**
 * The armed suffix, in words that are true for every way of pressing a button. (C-M4)
 *
 * <p>
 * It said "tap again to confirm". Reviewer C was on a keyboard and had not tapped anything;
 * the same sentence is read out to a screen-reader user driving a desktop with no touchscreen
 * at all, and to a speech-control user who says the control's name. "Tap" is one of three ways
 * in, named as though it were the only one — and on the control where being sure what you are
 * about to do matters most.
 * </p>
 *
 * <p>
 * "Choose" covers a tap, a click, Enter, Space and a spoken command without naming any of
 * them. The word "again" is the load-bearing half and it survives, so a test matching
 * <code>/again to confirm/</code> holds across the change.
 * </p>
 */
const CONFIRM_AGAIN = "choose again to confirm";

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

/**
 * A route change, if there is a router above this control — and nothing at all if there is not.
 *
 * <p>
 * `useLocation` would be the obvious thing and it throws outside a `Router`, which this
 * component is rendered outside of by its own unit tests and by half a dozen primitive tests
 * that have no business mounting a router. Reading the context directly answers the same
 * question and answers "there is no router" instead of raising.
 * </p>
 */
function useRouteKey(): string {
  const located = useContext(UNSAFE_LocationContext) as
    { location?: { pathname?: string; search?: string; hash?: string } } | null;
  const location = located?.location;
  if (!location) return "";
  return `${location.pathname ?? ""}${location.search ?? ""}${location.hash ?? ""}`;
}

/** The base look of both buttons in the armed pair, and of the trigger they replace. */
const CONTROL_CLASS = cn(
  /**
   * `items-stretch`, not `items-center` — and this is what actually made `break-words` work.
   *
   * <p>
   * In a column flex box, `align-items: center` sizes each item to its own MAX-CONTENT
   * width and centres that box. So the label's box was as wide as the word regardless of
   * the button, and `overflow-wrap: break-word` had nothing to break inside: there was no
   * line to be too long for. Stretching the label to the button's content width is what
   * gives the break a boundary; `text-center` keeps it looking the same as before.
   * </p>
   */
  /**
   * The padding is in PIXELS for B12's reason, and it is not cosmetic here.
   *
   * `px-3 py-2` is 24 px and 16 px a side at a 32 px root font size — 48 px of horizontal
   * padding inside a 128 px column, which left 80 px for a word that needs 95 and broke
   * "Cancel" into "Cance / l". The text scales; the padding around it does not need to.
   */
  "flex flex-col items-stretch justify-center rounded-lg px-[12px] py-[8px] text-center text-sm font-semibold",
  // The primitive's `whitespace-nowrap` would undo `break-words` below; a confirm wraps.
  "whitespace-normal",
  // `duration-base`, not `duration-200` — the same number, from the motion block in
  // `lib/tokens.ts`, so that this control's colour cross-fade and the feedback theme's
  // phases are timed by one source rather than by a literal that happens to agree.
  "transition-colors duration-base ease-standard motion-reduce:transition-none",
  /**
   * `min-h-11`, and no `overflow-hidden`.
   *
   * 44 px is the touch target, and there is nothing left on this control that could clip its
   * own words: the consequence is no longer inside it.
   */
  "min-h-11 max-w-full min-w-0",
  /**
   * `break-words`, found by looking at it.
   *
   * <p>
   * Two buttons side by side in the Courts row's last grid column is about 135 px each, and
   * at a 32 px root font size "Deactivate" is wider than that. It did not wrap — a word has
   * no break opportunity in it — so it rendered straight out of the red fill on both sides:
   * a screenshot at 320 px with a 32 px root shows "activ" sitting on the card behind the
   * button. `overflow-wrap: break-word` breaks the word rather than the layout, which on a
   * control whose whole job is to be legible is the right way round.
   * </p>
   */
  "break-words",
  // C8 — a transparent boundary that forced colours turns into a real one. A filled button
  // whose only edge is its fill looks like body text once the fill is forced away; the
  // `forced-colors` block in index.css is the other half.
  "border border-transparent",
  // The lift, the cursor and the focus ring come from the base layer in index.css; this
  // control keeps only its own colour transition. `no-lift` because a grid cell that rises
  // would shift the cells packed against it.
  "no-lift",
);

/**
 * Side by side wherever side by side is legible, and stacked where it is not. (B5)
 *
 * <p>
 * <b>Why not simply `grid-cols-2`.</b> That is `minmax(0, 1fr)` twice, so neither button
 * contributes any width to the track around it — and the Courts row's last column is `auto`.
 * Measured at 320 px with a 32 px root font: the pair got 135 px between them, and
 * "Deactivate" rendered straight out of its own red fill on both sides. Letting the word
 * break instead produced one LETTER per line, which is worse than the overflow it replaced.
 * A 96 px floor on each button fixed the overflow and left the words barely readable.
 * </p>
 *
 * <p>
 * <b>What `auto-fit` does that a fixed pair cannot.</b> Two columns whenever the floor will
 * fit twice, and one column — the buttons stacked — when it will not. That is the B5 ruling
 * where the ruling is about anything: side by side is what keeps the Cancel on screen beside
 * the confirm, and at a width where side by side means four letters a line it has stopped
 * doing that. Stacked, the pair is 2 × 44 px plus a gap, which is on screen at every size
 * this product is used at; the failure B5 was raised on was a 1 232 px CONSEQUENCE pushing
 * the Cancel below the fold, and the consequence is no longer inside the control at all.
 * </p>
 *
 * <p>
 * <b>The floor is `6rem`, and the unit is the whole point.</b> It was `96px`, which is the
 * same number — at a 16 px root font size. At a 32 px one it is half of what it needs to be,
 * and the look pass found exactly that on `/admin/devices` at 320 px: the pair went side by
 * side in about 192 px, and at 32 px text "Delete" rendered as "Dele / te" and "Cancel" as
 * "Cance / l". Words broken across lines on the two buttons of a destructive confirm, which
 * is the failure the floor exists to prevent, reintroduced by the floor itself.
 * </p>
 *
 * <p>
 * <b>This is the opposite of the rule B12 applies to the chrome, and deliberately so.</b>
 * There the boxes are in pixels because what they protect is a FINGERTIP, and 44 px is 44 px
 * whatever size the text is. Here what the floor protects is a WORD, and a word at a 32 px
 * root is twice as wide as the same word at 16 px. A measurement belongs in the unit of the
 * thing it is measuring; the two rules disagree because they are about different things.
 * </p>
 *
 * <p>
 * <b>`min(6rem, 100%)`, because a `minmax` minimum is a HARD minimum.</b> A bare `6rem` floor
 * is 192 px at a 32 px root, and the Courts row hands this control 140 px there — so `auto-fit`
 * produced one column 52 px wider than the box containing it, and the button rendered out over
 * the card. That is the overflow this whole grid exists to prevent, reintroduced by raising the
 * floor to fix a different case. `min(…, 100%)` is the standard guard: the floor, or the whole
 * of what there is, whichever is smaller.
 * </p>
 */
const ARMED_GRID_CLASS = "grid grid-cols-[repeat(auto-fit,minmax(min(6rem,100%),1fr))] gap-2";

/**
 * A glyph in front of a label, WITHOUT turning the label into a flex item.
 *
 * <p>
 * <b>This is the third time this exact arithmetic has bitten this file.</b> The obvious
 * shape — <code>&lt;span class="flex items-center gap-1.5"&gt;{glyph}{label}&lt;/span&gt;</code>
 * — makes the label a flex item, and `CONTROL_CLASS` carries `break-words`
 * (<code>overflow-wrap: break-word</code>), which drops a flex item's automatic minimum size to
 * roughly ONE CHARACTER. Flex is then free to squeeze it to nothing. Measured by
 * `e2e/confirm-armed.spec.ts` at 320 px: "Cancel" rendered over <b>three lines</b> in an 84 px
 * column whose widest word needs 45, and "Deactivate" over two in the same column. Adding
 * `min-w-0` to the label — which looks like the fix — is the instruction to allow exactly that.
 * </p>
 *
 * <p>
 * Inline layout has no such minimum. The glyph is an inline-block that the text flows around,
 * so the label wraps only when it genuinely does not fit, which is what `break-words` is for
 * and what every measurement in this file assumes. `align-[-0.2em]` sits the mark on the text's
 * baseline rather than on the line box's.
 * </p>
 */
function GlyphLabel({ glyph, children }: { glyph: React.ReactNode; children: React.ReactNode }) {
  if (!glyph) return <>{children}</>;
  return (
    <span className="block w-full text-center">
      <span className="mr-1.5 inline-block align-[-0.2em]">{glyph}</span>
      {children}
    </span>
  );
}

export function ConfirmButton({
  idleLabel,
  confirmLabel = "Tap to confirm",
  cancelLabel = "Cancel",
  onConfirm,
  className,
  tone = "info",
  idleClassName = IDLE_BY_TONE[tone],
  armedClassName = ARMED_LOOK,
  disabled = false,
  ariaLabel,
  subject,
  focusAfter,
  intent = INTENT_BY_TONE[tone],
}: ConfirmButtonProps) {
  const feedback = useActionFeedback(intent);
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  // `seq` so that two identical announcements in a row are two announcements: a live region
  // whose text does not change is a live region that says nothing, and cancelling twice is
  // exactly the case where silence reads as "the control ignored me". (C3)
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number }>({ text: "", seq: 0 });
  // On the WRAPPER, not on a button: the Cancel beside the confirm is part of this control,
  // and focus moving between the two is not focus leaving.
  const groupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  /** Set when the control settles after an action, so focus is restored rather than dropped. */
  const restoreFocus = useRef(false);
  /** Whether the press that armed it came from a person whose focus was on the trigger. */
  const armedFromTrigger = useRef(false);
  const routeKey = useRouteKey();

  const say = (text: string) => setAnnouncement((previous) => ({ text, seq: previous.seq + 1 }));

  // Set on mount as well as cleared on unmount. Without the assignment this effect only ever
  // wrote `false`, and React's development double-invoke runs mount → cleanup → mount — so
  // `mounted.current` was false from the first render onwards and the `finally` below never
  // cleared `pending`. The button stuck on "Working…" for ever after one successful action.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** Back to rest, saying so. Every way out of the armed state comes through here. */
  const disarm = () => {
    setArmed(false);
    say(CONFIRM_CANCELLED_ANNOUNCEMENT);
  };

  /**
   * Whether focus is inside this control right now.
   *
   * <p>
   * Every focus move this component makes is conditional on it, and that is the whole rule:
   * <b>a control may move focus within itself, and may put back focus it is about to destroy;
   * it may never take focus from somewhere else.</b> A pointer user reading a form with an
   * armed control on the far side of the page has their focus wherever they left it, and a
   * confirm that yanks it is a worse defect than the silent disarm this replaced.
   * </p>
   */
  const holdsFocus = () => {
    const active = document.activeElement;
    return active !== null && Boolean(groupRef.current?.contains(active));
  };

  /** Cancel, from the button or from Escape: focus goes back to the control it came from. */
  const cancel = () => {
    restoreFocus.current = holdsFocus();
    disarm();
  };

  // Escape, and a pointer press anywhere outside the group. Neither waits for anything.
  useEffect(() => {
    if (!armed || pending) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (groupRef.current && !groupRef.current.contains(e.target as Node)) disarm();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancel(); };
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [armed, pending]);

  /**
   * A route change disarms it. (B5)
   *
   * <p>
   * The banner store re-reads on navigation and the page under this control is replaced, so an
   * armed control that survived the navigation would be armed about a screen that is no longer
   * there. Silent rather than announced: the route announcer is already saying where the person
   * has arrived, and two live regions talking at once is worse than one of them being quiet.
   * </p>
   */
  const firstRoute = useRef(routeKey);
  useEffect(() => {
    if (routeKey === firstRoute.current) return;
    firstRoute.current = routeKey;
    setArmed(false);
    setPending(false);
    setAnnouncement((previous) => ({ text: "", seq: previous.seq + 1 }));
  }, [routeKey]);

  /**
   * Where focus is, at each step. (C3 / C4)
   *
   * <ul>
   *   <li><b>Armed</b> — the Cancel, which is the safe one. Arming with focus on the
   *       destructive button is how a second Enter, pressed by somebody who has not finished
   *       hearing the prompt, does the thing.</li>
   *   <li><b>Cancelled</b> — the trigger the person pressed, which is where they were.</li>
   *   <li><b>Settled after an action</b> — the trigger, but only if nothing else has claimed
   *       focus. The doors pages move focus to a receipt heading when a fleet action lands,
   *       and this effect runs before theirs (children settle first), so theirs wins.</li>
   * </ul>
   */
  useEffect(() => {
    if (armed && !pending) {
      if (armedFromTrigger.current) cancelRef.current?.focus();
      armedFromTrigger.current = false;
      return;
    }
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    // Only where focus is genuinely adrift. The doors pages move focus to a receipt heading
    // when a fleet action lands; a child effect runs before a parent's, so by the time
    // theirs runs this has already declined to compete with it.
    if (active === null || active === document.body) triggerRef.current?.focus();
  }, [armed, pending]);

  /** The armed block, brought to where it can be read — never past what the caller needs. */
  useEffect(() => {
    if (!armed) return;
    groupRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [armed]);

  const arm = () => {
    if (disabled || pending) return;
    // Captured HERE rather than read in the effect: by the time the effect runs the trigger
    // has been unmounted, so "was the person's focus on the thing they just pressed" is a
    // question only this moment can answer.
    armedFromTrigger.current = holdsFocus();
    setArmed(true);
    // The consequence, and then what to do about it. The trailing sentence is not padding:
    // it is the only thing that tells a listener the control has become TWO controls, and it
    // is also what keeps this region's text from being character-identical to the paragraph
    // on screen — a `getByText` for the consequence would otherwise match both.
    //
    // A-M8 / B9: it said "…or Cancel to stop" on a control whose way out is labelled "Keep it
    // open". There is no Cancel on that screen, so a listener was told to find a button that
    // does not exist — and the one word they could have searched for was the one word the
    // sentence did not contain. It reads the REAL labels now, in the order the two buttons
    // are in, and it names neither a tap nor a key (C-M4).
    say(`${textOf(confirmLabel)} Two buttons now: ${cancelLabel} to stop, or ${textOf(idleLabel)} to go ahead.`);
  };

  const confirm = async () => {
    if (disabled || pending) return;
    setPending(true);
    try {
      /**
       * A refusal is a report, not an unhandled rejection. (and this is a behaviour change)
       *
       * <p>
       * This was <code>await Promise.resolve(onConfirm())</code> inside a bare
       * <code>try/finally</code>, so an <code>onConfirm</code> that rejected settled the
       * control, announced <b>nothing at all</b>, and let the rejection escape the
       * <code>void confirm()</code> on the click handler as an unhandled promise rejection: a
       * console error no member ever sees, on a control that looks as though it ignored them.
       * </p>
       *
       * <p>
       * <code>feedback.run</code> catches it, reaches the failure phase, and hands back an
       * outcome rather than a value — which is the whole reason it does not simply return
       * <code>T | undefined</code>. Most <code>onConfirm</code>s resolve to
       * <code>undefined</code>, so "did it work" is not a question a value can answer, and a
       * control announcing "Done." over a refusal is worse than one announcing nothing.
       * </p>
       */
      const outcome = await feedback.run(onConfirm);
      if (mounted.current) {
        if (outcome.ok) {
          const result = outcome.value;
          say(typeof result === "string" && result ? result : CONFIRM_DONE_ANNOUNCEMENT);
        } else {
          say(CONFIRM_FAILED_ANNOUNCEMENT);
        }
      }
    } finally {
      if (mounted.current) {
        restoreFocus.current = holdsFocus();
        setPending(false);
        setArmed(false);
      }
      /**
       * R3-10 — and OUTSIDE the `mounted` guard, which is the whole point.
       *
       * <p>
       * The control that did the thing is usually the thing that goes: "Shut this door" is
       * replaced by "Reopen this door", so `triggerRef` is null by the time the effect above
       * runs and focus is left on `<body>`. `focusAfterAction` outlives this component, waits
       * for the caller's target to be rendered, and declines if anything else has claimed
       * focus in the meantime — including this control's own restored trigger.
       * </p>
       */
      focusAfterAction(focusAfter ?? pageHeading);
    }
  };

  /**
   * Focus leaving the whole group disarms it — and does NOT drag focus back.
   *
   * A browser moves focus on POINTERDOWN, so a press on Cancel fires this focusout before the
   * Cancel's own click; `relatedTarget` inside the group is what tells the two apart. Leaving
   * on purpose is announced and left alone: yanking focus back to a control somebody has just
   * tabbed away from is worse than the armed state it is tidying up.
   */
  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!armed || pending) return;
    const next = e.relatedTarget as Node | null;
    if (next && groupRef.current?.contains(next)) return;
    disarm();
  };

  const idleText = textOf(idleLabel);
  const consequence = textOf(confirmLabel);
  const showingArmed = armed;
  /**
   * <b>This control wears a glyph on its OUTCOME and never at rest — and that is measured.</b>
   *
   * <p>
   * The armed pair is a two-column grid whose columns are about 84 px at 320 px, and the
   * button's own padding leaves roughly 60 px of content box. A 16 px mark plus its 6 px gap
   * takes a third of that: `e2e/confirm-armed.spec.ts` caught "Cancel" over three lines and
   * "Deactivate" over two, on the two screens the spec walks. Every decoration ever put inside
   * this control has cost a broken word — it is the same finding as the 45-word consequence
   * that used to be its label, and as the `h-11` the component now strips off call sites.
   * </p>
   *
   * <p>
   * Nothing is lost. Ruling 4 already exempts destructive actions from the thumb, and
   * `tone="danger"` is what almost every call site here passes; the member-facing confirm and
   * decline pair that GOAL 12 is really about is the booking dialog, which is two `Button`s
   * with room for a mark beside each word. What this control keeps is the rest of the theme:
   * the press, the working phase, the colour, the shake — and the refusal mark, which appears
   * on the TRIGGER once the armed pair has gone and there is a full row to draw it in.
   * </p>
   */
  const outcomeGlyph = feedback.phase === "success" || feedback.phase === "failure" ? feedback.glyph : null;

  return (
    <div
      ref={groupRef}
      onBlur={handleBlur}
      /*
       * What a sweep finds this control BY, and it earns its place rather than being a test
       * hook for its own sake.
       *
       * The e2e sweeps used to select every confirm by its shape — a div holding a direct
       * `span[aria-live="polite"]` — precisely so that a control arriving on one of these
       * screens next month is measured without anybody remembering to add it. That shape
       * stopped being exclusive: `Alert` renders its standing live region as a FRAGMENT
       * sibling, so every container holding an `Alert` now answers the same selector, and the
       * sweeps started measuring a notice instead of a confirm — on the doors overview the
       * first "confirm" they found had no way out, because it was a banner.
       *
       * A marking on the group keeps the property that mattered (every ConfirmButton is found,
       * automatically) and drops the one that broke (anything else shaped like one is too).
       */
      data-confirm-group=""
      className={cn("min-w-0", showingArmed && ARMED_GRID_CLASS)}
    >
      {showingArmed ? (
        <>
          {/**
            * The consequence, as page text. (B5 / C2 / C7)
            *
            * `col-span-2` above the pair, at the page's own 14 px, wrapping freely, with
            * nothing that could clip it. It was the armed control's LABEL until this round,
            * which is what made a 45-word sentence a layout problem instead of a sentence.
            */}
          <p className="col-span-full text-sm leading-snug text-text-primary">{confirmLabel}</p>
          {/**
            * The way out comes FIRST, and that is C-H1. (C-H1 / B5 / C10)
            *
            * <p>
            * Focus lands on this button when the control arms, because it is the safe one. It
            * was also the LAST thing in the group, so the natural Tab out of it left the group
            * entirely: the armed state blurred, cancelled itself silently, and dropped the
            * keyboard on "Delete this door" — the next control on the page, and the most
            * destructive one. The confirm was behind it, reachable only by Shift+Tab, which is
            * not a thing anybody tries when the obvious key appears to have cancelled.
            * </p>
            *
            * <p>
            * Safe first, destructive second, focus on the first: Tab now reaches the other
            * option, exactly as it does in a two-button dialog, and leaving the pair in either
            * direction is a deliberate departure rather than a mis-step.
            * </p>
            *
            * <p>
            * <b>Named by its own label plus the SUBJECT.</b> "Cancel" alone, heard in a list of
            * controls, names nothing — and `Keep it open — Shut this door` (C-M3) names it
            * after the thing it refuses to do. `subject` is a noun, so the name says what is
            * being kept. It also keeps this button's name from being a superstring of the
            * control's, which is what made every `getByRole("button", { name: /…/ })` in the
            * suite match two elements the moment a control armed.
            * </p>
            *
            * <p>
            * The subject now comes from {@link confirmSubject}, which also reaches the doors
            * console's call sites — they pass the door's name through `ariaLabel` rather than
            * `subject`, fell through to the idle label, and got C-M3 back verbatim.
            * </p>
            *
            * <p>
            * <b>Item 12 — this button is the DECLINE half of the pair.</b> It wears the
            * decline glyph (thumbs-down, or ✕ where the club has chosen marks) whatever the
            * control's own intent is, because refusing a deletion is not itself destructive.
            * The glyph is `aria-hidden` and sits beside the word, always.
            * </p>
            */}
          <button
            ref={cancelRef}
            type="button"
            disabled={pending}
            data-confirm="stop"
            aria-label={`${cancelLabel} — ${confirmSubject(subject, ariaLabel, idleText)}`}
            onClick={(e) => { e.stopPropagation(); cancel(); }}
            // The outline look AFTER the control's own transparent edge would lose to it (both are
            // border colours, and tailwind-merge keeps the later), so the edge is restated last.
            className={cn(look("outline"), CONTROL_CLASS, "border-control")}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={disabled}
            /**
             * B5, forced colours — the two buttons were identical without it.
             *
             * <p>
             * Windows High Contrast throws away every author colour, so the orange confirm and
             * the white cancel became two identically-bordered boxes with different words in
             * them. `index.css` gives this attribute a heavier edge in that mode: the
             * distinction survives the colours being taken away, which is the whole
             * requirement. Nothing here depends on it in ordinary rendering.
             * </p>
             */
            data-confirm="go"
            aria-label={confirmName(idleText, ariaLabel, consequence)}
            /*
              Pending is `aria-disabled`, never `disabled` (design-system.md, Async actions): a
              disabled button drops focus to <body> the instant the work starts. `confirm()`
              already ignores a second press while it is in flight.
            */
            aria-disabled={pending || undefined}
            // No `aria-pressed`. It was set to the armed flag, so a screen reader said
            // "pressed" on a control that had done nothing yet — the word for "done" used for
            // "about to". This is not a toggle either: the confirm is a different button, not
            // the off half of the first. The prompt is ANNOUNCED instead, below.
            aria-busy={pending}
            onClick={(e) => { e.stopPropagation(); void confirm(); }}
            /*
              Item 12 — `feedback.className` LAST, and that ordering is the whole of it.
              `tailwind-merge` keeps the later of two conflicting utilities, so the outcome's
              fill has to come after `armedClassName` and after the caller's own classes or a
              success settles invisibly under the armed orange.
            */
            {...feedback.props}
            className={cn(
              look("secondary"), CONTROL_CLASS, armedClassName, pending && "cursor-progress",
              withoutFixedHeight(className), feedback.className,
            )}
          >
            {/* Working: the spinner beside the SAME words, so the button neither changes its
                name nor its width. It said "Working…", which is the one label on the control
                that says nothing about what it is doing. */}
            <GlyphLabel glyph={pending ? <Spinner /> : outcomeGlyph}>{idleLabel}</GlyphLabel>
          </button>
        </>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-label={accessibleName(idleText, ariaLabel)}
          aria-busy={false}
          onClick={(e) => { e.stopPropagation(); arm(); }}
          /*
            The trigger carries the OUTCOME, because by the time there is one this is the only
            button left: `confirm()`'s `finally` sets `armed` false, so the pair unmounts and
            this re-renders — with `data-fb="success"` on it for the hold. That is also where
            `focusAfterAction` puts the keyboard back, so the person who pressed it is looking
            at the thing that changed.
          */
          {...feedback.props}
          className={cn(look("secondary"), CONTROL_CLASS, idleClassName, withoutFixedHeight(className), feedback.className)}
        >
          <GlyphLabel glyph={outcomeGlyph}>{idleLabel}</GlyphLabel>
        </button>
      )}

      {/**
        * What replaced `aria-pressed` — ONE polite region, for every state this control has.
        *
        * <p>
        * Polite, because arming is something the person just did on purpose. It carries the
        * consequence on arm, "Cancelled — nothing was changed." on every disarm (C3: the
        * disarm used to be silent, so a screen-reader user could not tell whether the control
        * was loaded or at rest), and the caller's result — or "Done." — on completion.
        * </p>
        *
        * <p>
        * `aria-live` WITHOUT `role="status"`, deliberately. The role is the same live region
        * plus a landmark, and a screen full of these controls — the doors overview renders one
        * per door and two for the fleet — would carry a dozen status landmarks that are empty
        * most of the time. It also collides with the one status region a page really does have:
        * `getByRole("status")` on the doors overview started finding eleven.
        * </p>
        */}
      <span aria-live="polite" className={cn("sr-only", showingArmed && "col-span-full")}>
        <span key={announcement.seq}>{announcement.text}</span>
      </span>
    </div>
  );
}
