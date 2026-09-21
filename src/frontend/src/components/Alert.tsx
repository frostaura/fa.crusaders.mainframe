import { type HTMLAttributes } from "react";
import { cn } from "../lib/utils";

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
 * past and then presses the button again, having changed nothing.
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
 * How loudly this alert speaks — which is not the same question as what it looks like.
 *
 * <ul>
 *   <li><b>assertive</b> (`role="alert"`) — a screen reader says it immediately and over
 *       whatever it was in the middle of. Right for something that has just happened because
 *       the person did something: a refusal, a failed save.</li>
 *   <li><b>polite</b> (`role="status"`) — said when the reader reaches a pause. Right for a
 *       STANDING fact about the screen somebody has just arrived at.</li>
 *   <li><b>off</b> — no live region at all. For an alert on a page nobody is reading live: the
 *       printable door card, a panel rendered into a PDF.</li>
 * </ul>
 */
export type AlertLive = "assertive" | "polite" | "off";

const ROLE_BY_LIVE: Record<AlertLive, string | undefined> = {
  assertive: "alert",
  polite: "status",
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
   */
  live?: AlertLive;
};

export function Alert({ tone = "danger", live, className, ...props }: AlertProps) {
  return (
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
        "rounded-lg border-l-4 px-3 py-2.5 text-sm",
        TONES[tone],
        className,
      )}
      {...props}
      role={ROLE_BY_LIVE[live ?? defaultLive(tone)]}
    />
  );
}
