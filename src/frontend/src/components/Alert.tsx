import { Children, isValidElement, type HTMLAttributes } from "react";
import { cn } from "../lib/utils";
import { useStandingAnnouncement } from "../lib/announce";
import { CheckCircle, Info, Warning, WarningCircle, type Icon } from "./ui/icons";

/**
 * A message the member has to read before they do anything else.
 *
 * <p>
 * The danger tone existed three times, character for character, in `Login.tsx`, `Register.tsx`
 * and `ForgotPassword.tsx` — a string that had to be copied correctly into every new screen that
 * wanted to refuse something, and that would silently drift the first time one of them was
 * touched. A repeated visual treatment is a component; that is the whole of the reason this
 * file exists.
 * </p>
 *
 * <p>
 * The left rule is not decoration. A refusal set as plain red body copy is one a member skims
 * past and then presses the button again, having changed nothing. Nor is the icon: colour is
 * never the only signal (design-system.md, Accessibility floor), so each tone carries its own
 * Phosphor mark — 1rem bold beside sm text, `aria-hidden`, because the words are the message.
 * </p>
 */
export type AlertTone = "danger" | "success" | "info" | "warning";

/**
 * Tone → fill. Each pair is measured in `tokens.test.ts` at or above 4.5:1, which is why an
 * alert takes a tone from this closed set rather than arbitrary classes: a hand-written pairing
 * is one nobody measures.
 */
const TONES: Record<AlertTone, string> = {
  danger: "border-danger-strong bg-danger-soft text-danger-strong",
  success: "border-success-strong bg-success-soft text-success-strong",
  info: "border-info-strong bg-info-soft text-info-strong",
  warning: "border-warning-strong bg-warning-soft text-warning-strong",
};

/**
 * The mark hangs in the left gutter, level with the first line; under a 14rem container (large
 * text, a narrow box) it floats at the start of the first line instead and the lines under it take
 * the whole width (R8 L8-11: a 72px gutter down every line of a 256px callout at 320 / 200 %).
 */
const ICON_PLACE = [
  "absolute left-3 top-3",
  "[@container(max-width:14rem)]:static [@container(max-width:14rem)]:float-left [@container(max-width:14rem)]:mr-2 [@container(max-width:14rem)]:mt-0.5",
].join(" ");

/** Tone → mark. The shape differs as well as the colour, so the tone survives forced colours. */
const ICONS: Record<AlertTone, Icon> = {
  danger: WarningCircle,
  success: CheckCircle,
  info: Info,
  warning: Warning,
};

/**
 * How loudly this alert speaks — which is not the same question as what it looks like.
 *
 * <ul>
 *   <li><b>assertive</b> (`role="alert"`) — a screen reader says it immediately and over
 *       whatever it was in the middle of. Right for something that has just happened because
 *       the person did something: a refusal, a failed save.</li>
 *   <li><b>polite</b> (`role="status"`) — said when the reader reaches a pause. Right for a
 *       STANDING fact about the screen somebody has just arrived at.</li>
 *   <li><b>standing</b> — polite, and said ONCE: on arrival, and again only when the words
 *       themselves change. For a fact about the screen that is re-rendered by a poll — "Front
 *       door is shut" — where `polite` still re-announces every time the block remounts.</li>
 *   <li><b>off</b> — no live region at all. For an alert on a page nobody is reading live: the
 *       printable door card, a panel rendered into a PDF.</li>
 * </ul>
 */
export type AlertLive = "assertive" | "polite" | "standing" | "off";

/**
 * `standing` is deliberately NOT in this table: it puts no live role on the visible element at
 * all. See {@link StandingAnnouncement} — the announcement is a separate, invisible region, so
 * that re-rendering the banner is not the same event as saying it.
 */
const ROLE_BY_LIVE: Record<AlertLive, string | undefined> = {
  assertive: "alert",
  polite: "status",
  standing: undefined,
  off: undefined,
};

/**
 * What a tone means when the call site has not said. Unchanged from the behaviour every
 * existing call site was written against — see {@link Alert}.
 */
function defaultLive(tone: AlertTone): AlertLive {
  return tone === "danger" || tone === "warning" ? "assertive" : "polite";
}

type AlertProps = HTMLAttributes<HTMLParagraphElement> & {
  tone?: AlertTone;
  /**
   * Defaults to assertive for `danger` and `warning`, polite otherwise — which is what this
   * component did before the prop existed, and is right for the case it was written for: an
   * alert that appears BECAUSE somebody pressed something.
   *
   * <p>
   * Pass `polite` for a standing notice. "This door is shut" is a fact about a screen, not an
   * event, and an assertive region announcing it cuts across the heading on arrival and again
   * on every re-render. An assertive region used for the state of things is one people learn
   * to talk over, and the refusals go with it.
   * </p>
   *
   * <p>
   * Pass `standing` for a notice the page RE-RENDERS — a banner behind a 15-second poll, a
   * chrome banner re-read on navigation. `polite` still announces every time such a block
   * remounts, which over three minutes was the same fifty-word advisory twelve times (C-M2).
   * </p>
   */
  live?: AlertLive;
  /**
   * Which standing fact this is, for `live="standing"` only.
   *
   * <p>
   * A notice whose text can come back after something else — "Front door is shut", reopened,
   * shut again — has to name itself, or the second shut is swallowed as "already said". A
   * notice that only ever appears once needs nothing: the text is its own identity.
   * </p>
   */
  announceKey?: string;
};

export function Alert({ tone = "danger", live, className, announceKey, children, ...props }: AlertProps) {
  const Mark = ICONS[tone];
  const notice = (
    <p
      /*
       * AFTER the spread, deliberately — the opposite of every other attribute here.
       *
       * The urgency of a live region is this component's to decide, through the prop above,
       * and a `role` arriving in `...props` must not quietly win. It used to: the doors lane
       * got a polite standing notice by passing `role="status"` through the spread, which
       * worked only because the spread happened to sit after the role in the source. A
       * component whose accessibility semantics depend on line ordering has not decided
       * anything. `live` is the way to say it, and it is the only way.
       */
      className={cn(
        // The words stay DIRECT children of the <p> — call sites and tests find the notice by
        // its text — so the mark hangs in the left padding rather than sitting in a flex row
        // (a flex row would also make the text an anonymous item that cannot shrink).
        // R8 L8-11: the hanging gutter (icon + insets, in rem so it grows with the icon) steps
        // down to the plain inset when the text is large for the box around it — a rem query on
        // the nearest container (every page is one) — and the icon then floats in the first line.
        "relative break-words rounded-lg border-l-4 py-2.5 pl-9 pr-3 text-sm [@container(max-width:14rem)]:pl-3",
        "[@container(max-width:14rem)]:flow-root",
        TONES[tone],
        className,
      )}
      {...props}
      role={ROLE_BY_LIVE[live ?? defaultLive(tone)]}
    >
      {/* R8 L6-16: 1rem, so it grows with the words (it stayed 16px beside 28px text at 200 %). */}
      <Mark size="1rem" weight="bold" aria-hidden="true" className={ICON_PLACE} />
      {children}
    </p>
  );

  if (live !== "standing") return notice;
  return (
    <>
      {notice}
      <StandingAnnouncement text={textOf(children)} channel={announceKey} />
    </>
  );
}

/**
 * The announcement, in a region of its own that nothing re-renders. (R3-26)
 *
 * <p>
 * <b>Why it is not the banner itself.</b> A live region announces when its CONTENT changes, and
 * "changes" includes a remount: the block is conditional on a payload, the payload is re-read
 * every fifteen seconds, and every re-read that flips the condition is a fresh region with text
 * in it. The banner above is therefore given no live role at all, and what speaks is this —
 * an empty span that is written to exactly once per distinct fact, and never written back to
 * `""`, because emptying a live region is itself an event (C-M1).
 * </p>
 *
 * <p>
 * `aria-atomic` so the whole sentence arrives rather than the words that differ from last time.
 * </p>
 */
function StandingAnnouncement({ text, channel }: { text: string; channel?: string }) {
  const spoken = useStandingAnnouncement(text, channel);
  return <span aria-live="polite" aria-atomic="true" className="sr-only">{spoken}</span>;
}

/**
 * The words inside a node, whatever it is made of — an alert's children are frequently a
 * sentence with a `<strong>` or a `<Link>` in the middle of it, and what gets announced is the
 * whole sentence rather than the element tree.
 */
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    const inner = node.props as { children?: React.ReactNode };
    return Children.toArray(inner.children).map(textOf).join("");
  }
  return "";
}
