import { useId } from "react";
import { FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

/**
 * "Also remove the passkeys" — the one choice both code resets offer (member-code §10, §13): the
 * desk's reset for a lost phone, where it starts ON, and a member's own "Sign out everywhere",
 * where it starts OFF. One control, so the two dialogs cannot drift in how they ask.
 *
 * <p>
 * <b>The row is the hit target.</b> The switch is 44×26, so the whole row — name, hint and switch —
 * is one label at least 44px tall that flips it from anywhere (R2 leftovers). The label wraps the
 * switch, so a press on the switch itself is not re-dispatched; `aria-labelledby` keeps the name to
 * the label text and `aria-describedby` keeps the hint the description, as before.
 * </p>
 */
type Props = { label: string; hint: string; checked: boolean; onChange: (next: boolean) => void };

export function RevokePasskeysSwitch(props: Props) {
  const { label, hint, checked, onChange } = props;
  const id = useId();
  return (
    <FieldLabel
      data-revoke-passkeys=""
      className="grid min-h-11 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 font-normal"
    >
      <span id={`${id}-label`} className="col-start-1 row-start-1 text-sm font-semibold text-text-primary">{label}</span>
      <Switch
        className="col-start-2 row-span-2 row-start-1" checked={checked} onCheckedChange={onChange}
        aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`}
      />
      <span id={`${id}-hint`} className="col-start-1 row-start-2 block text-sm text-text-secondary">{hint}</span>
    </FieldLabel>
  );
}
