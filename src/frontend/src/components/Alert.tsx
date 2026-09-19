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

type AlertProps = HTMLAttributes<HTMLParagraphElement> & {
  tone?: AlertTone;
};

export function Alert({ tone = "danger", className, ...props }: AlertProps) {
  return (
    <p
      /*
       * `alert` for the tones that interrupt, `status` for the ones that inform.
       *
       * A screen reader announces `alert` immediately and over whatever it was saying, which is
       * right for a refusal and wrong for "saved" — an assertive live region used for every
       * confirmation is one users learn to ignore, taking the refusals with it.
       */
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn(
        "rounded-lg border-l-4 px-3 py-2.5 text-sm",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
