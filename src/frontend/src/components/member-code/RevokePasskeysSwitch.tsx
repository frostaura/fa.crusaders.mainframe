import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

/**
 * "Also remove the passkeys" — the one choice both code resets offer (member-code §10, §13): the
 * desk's reset for a lost phone, where it starts ON, and a member's own "Sign out everywhere",
 * where it starts OFF. One control, so the two dialogs cannot drift in how they ask.
 */
type Props = { label: string; hint: string; checked: boolean; onChange: (next: boolean) => void };

export function RevokePasskeysSwitch(props: Props) {
  const { label, hint, checked, onChange } = props;
  return (
    <Field className="grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4" data-revoke-passkeys="">
      <FieldLabel className="col-start-1 row-start-1 font-semibold">{label}</FieldLabel>
      <Switch className="col-start-2 row-span-2 row-start-1" checked={checked} onCheckedChange={onChange} />
      <FieldDescription className="col-start-1 row-start-2">{hint}</FieldDescription>
    </Field>
  );
}
