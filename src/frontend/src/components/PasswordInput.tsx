import { useState, type ComponentProps } from "react";
import { cn } from "../lib/utils";
import { PASSWORD_TOGGLE } from "../lib/authCopy";
import { Input } from "./ui/input";
import { IconButton } from "./ui/icon-button";
import { Eye, EyeSlash } from "./ui/icons";

/**
 * A password field with a show/hide control inside its right edge — every password on the
 * sign-in, join, reset and change screens.
 *
 * <p>
 * A member typing a password on a phone in the club foyer cannot see what the keyboard did, and
 * the commonest failed sign-in is a mistyped character nobody could check. Revealing it is the
 * cheap fix every modern sign-in offers; the field used to be a bare `type="password"`.
 * </p>
 *
 * <p>
 * It renders the ordinary `Input`, so a surrounding `Field` still wires its id, description,
 * error and `aria-invalid`. The toggle is an `IconButton` (44px, named, tooltip) and is
 * `type="button"` so Enter in the field still submits the form. Its name says what pressing it
 * will do ("Show password" / "Hide password") rather than carrying `aria-pressed` beside a
 * changing label, which screen readers announce as a contradiction.
 * </p>
 */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative min-w-0">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        // The browser must not offer to "correct" a password it can now read.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn("pr-12", className)}
      />
      <IconButton
        type="button"
        label={visible ? PASSWORD_TOGGLE.hide : PASSWORD_TOGGLE.show}
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 right-0 text-text-secondary hover:bg-transparent hover:text-text-primary"
      >
        {visible ? <EyeSlash /> : <Eye />}
      </IconButton>
    </div>
  );
}
