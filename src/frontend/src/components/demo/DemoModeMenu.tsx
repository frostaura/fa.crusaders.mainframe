import { useRef, useState } from "react";
import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ShieldCheck, Sparkle } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { DEMO_CODES, DEMO_COPY } from "@/lib/demoModeCopy";
import { describeFailure } from "@/lib/errors";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useClubMode, type ClubMode } from "./clubMode";
import { switchClub } from "./switchClub";

const CHOICES = [
  { value: "live", label: DEMO_COPY.live, icon: ShieldCheck },
  { value: "demo", label: DEMO_COPY.demo, icon: Sparkle },
] as const;

function isClubMode(value: string): value is ClubMode {
  return value === "live" || value === "demo";
}

/**
 * The account menu's Live / Demo choice — admins only, shaped like the Appearance group beside it
 * (radio items: arrow keys rove, Space/Enter choose, the checked one is announced). Choosing keeps
 * the menu open with the choice busy, because the first visit of the day makes the whole demo club
 * and can take a minute or two on the club's Pi; the club's yes then loads the app afresh in the other club (`switchClub`). A
 * refusal is a toast and the menu stays in the club it was in.
 */
export function DemoModeMenu({ userId }: { userId: string | null }) {
  const mode = useClubMode(userId);
  const [target, setTarget] = useState<ClubMode | null>(null);
  const targetRef = useRef<ClubMode | null>(null);
  const [leaving, setLeaving] = useState(false);
  const action = useAsyncAction((to: ClubMode) => switchClub(to), {
    success: () => setLeaving(true),
    failure: () => setTarget(null),
    toast: {
      failure: (error) => describeFailure(error, {
        action: targetRef.current === "demo" ? DEMO_COPY.switchToDemoAction : DEMO_COPY.switchToLiveAction,
        codes: DEMO_CODES,
      }),
    },
  });
  const busy = action.pending || leaving;
  const choose = (value: string) => {
    if (!isClubMode(value) || value === mode || busy) return;
    targetRef.current = value;
    setTarget(value);
    void action.run(value);
  };
  const working = busy && target ? (target === "demo" ? DEMO_COPY.opening : DEMO_COPY.closing) : null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{DEMO_COPY.menuLabel}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={(busy ? target : mode) ?? ""} onValueChange={choose}>
        {CHOICES.map(({ value, label, icon: Glyph }) => (
          <DropdownMenuRadioItem
            key={value} value={value} disabled={mode === null} aria-busy={busy && target === value ? true : undefined}
            data-club-mode={value} onSelect={(event) => event.preventDefault()}
          >
            {busy && target === value
              ? <Spinner className="text-text-muted" />
              : <Glyph size={16} aria-hidden="true" className="text-text-muted" />}
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <p role="status" data-club-mode-line="" className="max-w-full break-words px-3 pb-2 pt-1 text-xs text-text-muted">
        {working ?? DEMO_COPY.menuLine}
      </p>
    </>
  );
}
