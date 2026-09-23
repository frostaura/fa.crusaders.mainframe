import { useId, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MemberCombobox, type ComboboxMember } from "@/components/ui/member-combobox";
import { RadioCard, RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Demo, ThemePair } from "./parts";

/** Every form control, wired through `Field` so each has a label, help and (where shown) an error. */

const SAMPLE_MEMBERS: readonly ComboboxMember[] = [
  { id: "m1", name: "Nomsa Khumalo", subtitle: "League", balance: 274.25 },
  { id: "m2", name: "Sam Smith", subtitle: "Social", balance: 48 },
  { id: "m3", name: "Pieter van der Merwe", subtitle: "Junior", balance: -16 },
  { id: "m4", name: "Aisha Patel", subtitle: "League", balance: 0 },
  { id: "m5", name: "Dean Martin", subtitle: "Committee", balance: 1250.75 },
];

function TextFields() {
  const [name, setName] = useState("Nomsa Khumalo");
  const [email, setEmail] = useState("nomsa@");
  return (
    <div className="grid gap-4">
      <Field>
        <FieldLabel>Full name</FieldLabel>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <FieldDescription>As it appears on the booking grid.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Email</FieldLabel>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        <FieldError>{email.includes(".") ? null : "Enter an email address like name@club.co.za."}</FieldError>
      </Field>
      <Field>
        <FieldLabel>Member number</FieldLabel>
        <Input readOnly value="CR-0042" />
        <FieldDescription>Read only.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Club code</FieldLabel>
        <Input disabled value="Set by the club" />
      </Field>
      <Field>
        <FieldLabel>Reason</FieldLabel>
        <Textarea placeholder="Why is this credit being adjusted?" />
      </Field>
    </div>
  );
}

function SelectFields() {
  const [group, setGroup] = useState("league");
  const [member, setMember] = useState<string | null>("m1");
  return (
    <div className="grid gap-4">
      <Field>
        <FieldLabel>Group</FieldLabel>
        <Select value={group} onValueChange={setGroup}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Playing groups</SelectLabel>
              <SelectItem value="league">League</SelectItem>
              <SelectItem value="social">Social</SelectItem>
              <SelectItem value="junior">Junior</SelectItem>
              <SelectItem value="guest" disabled>Guest (retired)</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <MemberCombobox label="Book for" members={SAMPLE_MEMBERS} value={member} onChange={setMember} />
      <MemberCombobox label="Partner" members={SAMPLE_MEMBERS} value={null} onChange={() => undefined} error="Choose a partner first." />
    </div>
  );
}

function ChoiceFields() {
  const ids = useId();
  const [agree, setAgree] = useState(true);
  const [notify, setNotify] = useState(true);
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <Checkbox id={`${ids}-agree`} checked={agree} onCheckedChange={(v) => setAgree(v === true)} />
        <label htmlFor={`${ids}-agree`} className="text-sm text-text-primary">Email me receipts</label>
      </div>
      <div className="flex items-center gap-3">
        <Checkbox id={`${ids}-some`} checked="indeterminate" />
        <label htmlFor={`${ids}-some`} className="text-sm text-text-primary">Some courts selected</label>
      </div>
      <div className="flex items-center gap-3">
        <Checkbox id={`${ids}-off`} disabled />
        <label htmlFor={`${ids}-off`} className="text-sm text-text-secondary">Unavailable option</label>
      </div>
      <Field className="flex items-center justify-between gap-4">
        <FieldLabel>Notify me when a court frees up</FieldLabel>
        <Switch checked={notify} onCheckedChange={setNotify} />
      </Field>
      <Field className="flex items-center justify-between gap-4">
        <FieldLabel>Off and disabled</FieldLabel>
        <Switch disabled />
      </Field>
    </div>
  );
}

function RadioFields() {
  const ids = useId();
  const [length, setLength] = useState("60");
  const [who, setWho] = useState("me");
  return (
    <div className="grid gap-5">
      <div className="grid gap-3">
        <p id={`${ids}-length`} className="text-sm font-medium text-text-primary">Session length</p>
        <RadioGroup value={length} onValueChange={setLength} aria-labelledby={`${ids}-length`}>
          {["30", "60", "90"].map((minutes) => (
            <div key={minutes} className="flex items-center gap-3">
              <RadioGroupItem id={`${ids}-${minutes}`} value={minutes} />
              <label htmlFor={`${ids}-${minutes}`} className="text-sm text-text-primary">{`${minutes} minutes`}</label>
            </div>
          ))}
        </RadioGroup>
      </div>
      <RadioGroup value={who} onValueChange={setWho} aria-label="Book as">
        <RadioCard value="me" title="Book for myself" description="Charged to your wallet: 8 cr." />
        <RadioCard value="member" title="Book for a member" description="Charged to their wallet." />
        <RadioCard value="hold" title="Club hold" description="Admins only." disabled />
      </RadioGroup>
    </div>
  );
}

export function FieldsSection() {
  return (
    <div className="flex flex-col gap-10">
      <Demo title="Input and textarea" note="16px on phones so iOS never zooms. The error is words beside an icon, never colour alone.">
        <ThemePair>{() => <TextFields />}</ThemePair>
      </Demo>
      <Demo title="Select and member combobox" note="The lists portal to the page and follow the page theme switch, not the panel.">
        <ThemePair>{() => <SelectFields />}</ThemePair>
      </Demo>
      <Demo title="Checkbox and switch">
        <ThemePair>{() => <ChoiceFields />}</ThemePair>
      </Demo>
      <Demo title="Radio group and radio cards">
        <ThemePair>{() => <RadioFields />}</ThemePair>
      </Demo>
    </div>
  );
}
