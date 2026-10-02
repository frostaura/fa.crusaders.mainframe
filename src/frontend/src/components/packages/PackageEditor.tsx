import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Alert } from "@/components/Alert";
import { Minutes } from "@/components/Minutes";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { adminEndpoints, type AdminPackage, type MemberGroup } from "@/lib/adminApi";
import { describeFailure } from "@/lib/errors";
import { unsureSentence, writeOrReadBack } from "@/lib/lostReply";
import { LOST_REPLY } from "@/lib/lostReplyCopy";
import {
  PACKAGES_COPY as COPY, PACKAGES_LOST, PACKAGE_LIMITS, baselineOf, minutesComplaint, parsePackageMinutes, parsePrice,
  perHour, priceComplaint, savingOf, shelfWith, type ShelfKey,
} from "@/lib/packagesCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { formatMoney } from "@/lib/utils";

/**
 * Add or edit one minutes package (P13 §3.5) — the form the Packages page shows beside its list
 * on a desktop and in a sheet on a phone.
 *
 * <p>
 * <b>Every rule is said at its field, before anything is sent</b> (§3.5's bounds): a name of 1–64
 * characters, whole minutes from 1 to 60 000 — filled in from hours with one press, and said back
 * as an amount ("= 5 h") — and a rand price above R0 in whole cents. The shelf is chosen once, at
 * creation; after that it is shown and explained, because the server refuses a change.
 * </p>
 *
 * <p>
 * <b>The member's sum is worked out as the admin types</b>: rand per hour, and what this package
 * saves against the smallest one on its shelf — §4.3's rule, the one the member's shelf shows.
 * </p>
 */
export type PackageEditorProps = {
  /** The package being edited, or "new". */
  pkg: AdminPackage | "new";
  /** Every package on sale (the shelf a saving is measured against); null when not read. */
  active: AdminPackage[] | null;
  /** The club's active groups, or null when they could not be read (a new package is then a club one). */
  groups: MemberGroup[] | null;
  onSaved: (saved: AdminPackage, said: string) => void;
  onCancel: () => void;
};

type Draft = { name: string; minutes: string; price: string; shelf: ShelfKey; order: string; reason: string };

function initialDraft(pkg: AdminPackage | "new"): Draft {
  if (pkg === "new") return { name: "", minutes: "", price: "", shelf: null, order: "0", reason: "" };
  return {
    name: pkg.name, minutes: String(pkg.minutes), price: pkg.price_zar.toFixed(2), shelf: pkg.group?.id ?? null,
    order: String(pkg.sort_order), reason: "",
  };
}

type Complaints = { name: string | null; minutes: string | null; price: string | null; order: string | null };

function complaintsOf(draft: Draft): Complaints {
  const name = draft.name.trim();
  return {
    name: name.length < 1 || name.length > PACKAGE_LIMITS.nameMax ? COPY.nameRequired : null,
    minutes: minutesComplaint(draft.minutes),
    price: priceComplaint(draft.price),
    order: /^\d+$/.test(draft.order.trim()) ? null : COPY.orderInvalid,
  };
}

/** The package on the list now that matches the draft — the proof a lost write landed. */
async function asDrafted(pkg: AdminPackage | "new", draft: Draft): Promise<AdminPackage | null> {
  const { packages } = await adminEndpoints.packages("active");
  const name = draft.name.trim();
  const found = pkg === "new"
    ? packages.find((p) => p.name === name && (p.group?.id ?? null) === draft.shelf)
    : packages.find((p) => p.id === pkg.id);
  const matches = found && found.name === name && found.minutes === parsePackageMinutes(draft.minutes)
    && found.price_zar === parsePrice(draft.price);
  return matches ? found : null;
}

type Written = { saved: AdminPackage; said: string };

async function write(pkg: AdminPackage | "new", draft: Draft): Promise<Written> {
  const name = draft.name.trim();
  const body = { name, minutes: parsePackageMinutes(draft.minutes)!, priceZar: parsePrice(draft.price)!, sortOrder: Number(draft.order) };
  const send = pkg === "new"
    ? () => adminEndpoints.packageCreate({ ...body, groupId: draft.shelf })
    : () => adminEndpoints.packageUpdate(pkg.id, { ...body, reason: draft.reason });
  const { value, proven } = await writeOrReadBack(send, () => asDrafted(pkg, draft));
  const done = pkg === "new" ? COPY.added(name) : COPY.saved(name);
  return { saved: value, said: proven ? LOST_REPLY.proven(done) : done };
}

export function PackageEditor({ pkg, active, groups, onSaved, onCancel }: PackageEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(pkg));
  const [tried, setTried] = useState(false);
  const isNew = pkg === "new";
  const problems = complaintsOf(draft);
  const save = useAsyncAction(() => write(pkg, draft), { success: (r) => onSaved(r.saved, r.said) });
  const nameRef = useRef<HTMLInputElement>(null);
  const minutesRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const orderRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const submit = () => {
    setTried(true);
    // Refused at the form, focus on the first field to fix — never a toast that fades.
    const first = (["name", "minutes", "price", "order"] as const).find((k) => problems[k]);
    if (first) { ({ name: nameRef, minutes: minutesRef, price: priceRef, order: orderRef })[first].current?.focus(); return; }
    void save.run();
  };
  const show = (k: keyof Complaints) => (tried || (k !== "name" && draft[k].trim() !== "") ? problems[k] : null);

  return (
    <form noValidate className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); submit(); }} data-package-editor="">
      <TextField label={COPY.nameLabel} description={COPY.nameDescription} complaint={tried ? problems.name : null}>
        <Input ref={nameRef} value={draft.name} maxLength={PACKAGE_LIMITS.nameMax} autoComplete="off" placeholder="5 hours" onChange={(e) => set({ name: e.target.value })} />
      </TextField>
      <MinutesField draft={draft} set={set} inputRef={minutesRef} complaint={show("minutes")} />
      <TextField label={COPY.priceLabel} description={COPY.priceDescription} complaint={show("price")}>
        <Input ref={priceRef} inputMode="decimal" autoComplete="off" className="tabular-nums" placeholder="550.00" value={draft.price} onChange={(e) => set({ price: e.target.value })} />
      </TextField>
      <ShelfField isNew={isNew} draft={draft} set={set} groups={groups} pkg={pkg} />
      <TextField label={COPY.orderLabel} description={COPY.orderDescription} complaint={show("order")}>
        <Input ref={orderRef} inputMode="numeric" autoComplete="off" className="w-28 tabular-nums" value={draft.order} onChange={(e) => set({ order: e.target.value })} />
      </TextField>
      {isNew ? null : (
        <Field>
          <FieldLabel>{COPY.reasonLabel}</FieldLabel>
          <Input autoComplete="off" value={draft.reason} placeholder={COPY.reasonPlaceholder} onChange={(e) => set({ reason: e.target.value })} />
        </Field>
      )}
      <Preview pkg={pkg} draft={draft} active={active} />
      <SaveFailure error={save.error} isNew={isNew} name={draft.name.trim()} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" disabled={save.pending} onClick={onCancel}>{COPY.cancel}</Button>
        <Button type="submit" pending={save.pending}>{isNew ? COPY.saveNew : COPY.saveEdit}</Button>
      </div>
    </form>
  );
}

/** A labelled field: the control, its complaint, and the rule it follows. */
type TextFieldProps = { label: string; description: string; complaint: string | null; children: ReactNode };

function TextField({ label, description, complaint, children }: TextFieldProps) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {children}
      <FieldError>{complaint}</FieldError>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

/** Why the save did not land — or, for a lost reply, that it may have. */
type SaveFailureProps = { error: unknown; isNew: boolean; name: string };

function SaveFailure({ error, isNew, name }: SaveFailureProps) {
  if (!error) return null;
  const lost = isNew ? PACKAGES_LOST.add(name) : PACKAGES_LOST.save(name);
  const action = isNew ? COPY.addAction : COPY.saveAction;
  const sentence = unsureSentence(error, lost) ?? describeFailure(error, { action, codes: COPY.errorCodes });
  return <Alert tone="danger" live="assertive">{sentence}</Alert>;
}

const HOURS = [1, 2, 5, 10] as const;

type MinutesFieldProps = {
  draft: Draft; set: (patch: Partial<Draft>) => void; inputRef: RefObject<HTMLInputElement | null>; complaint: string | null;
};

/** Whole minutes, with the hours that fill it in and the amount said back. */
function MinutesField({ draft, set, inputRef, complaint }: MinutesFieldProps) {
  const minutes = parsePackageMinutes(draft.minutes);
  return (
    <Field>
      <FieldLabel>{COPY.minutesLabel}</FieldLabel>
      <div className="flex flex-wrap items-center gap-3">
        <Input ref={inputRef} inputMode="numeric" autoComplete="off" className="w-32 tabular-nums" placeholder="300" value={draft.minutes} onChange={(e) => set({ minutes: e.target.value })} />
        {minutes !== null ? <span className="text-sm text-text-secondary" data-minutes-echo="">{COPY.minutesEcho(minutes)}</span> : null}
      </div>
      <div role="group" aria-label={COPY.hoursLabel} className="flex flex-wrap gap-2">
        {HOURS.map((h) => (
          <Button key={h} type="button" size="sm" variant="outline" aria-pressed={minutes === h * 60} onClick={() => set({ minutes: String(h * 60) })}>
            {COPY.hoursChip(h)}
          </Button>
        ))}
      </div>
      <FieldError>{complaint}</FieldError>
      <FieldDescription>{COPY.minutesDescription}</FieldDescription>
    </Field>
  );
}

type ShelfFieldProps = {
  isNew: boolean; draft: Draft; set: (patch: Partial<Draft>) => void; groups: MemberGroup[] | null; pkg: AdminPackage | "new";
};

/** Chosen once, at creation (`package_group_immutable`); shown and explained after that. */
function ShelfField({ isNew, draft, set, groups, pkg }: ShelfFieldProps) {
  if (!isNew && pkg !== "new") {
    return (
      <Field>
        <FieldLabel>{COPY.shelfLabel}</FieldLabel>
        <p className="text-sm font-semibold text-text-primary">{pkg.group?.name ?? COPY.clubOption}</p>
        <FieldDescription>{COPY.shelfFixed}</FieldDescription>
      </Field>
    );
  }
  return (
    <Field>
      <FieldLabel>{COPY.shelfLabel}</FieldLabel>
      <Select value={draft.shelf ?? "club"} onValueChange={(v) => set({ shelf: v === "club" ? null : v })} disabled={groups === null}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="club">{COPY.clubOption}</SelectItem>
          {(groups ?? []).map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <FieldDescription>{groups === null ? COPY.groupsCaveat : COPY.shelfFixed}</FieldDescription>
    </Field>
  );
}

/** Rand per hour, and the saving against the shelf's smallest package — as the member's shelf will say it. */
function Preview({ pkg, draft, active }: { pkg: AdminPackage | "new"; draft: Draft; active: AdminPackage[] | null }) {
  const minutes = parsePackageMinutes(draft.minutes);
  const price = parsePrice(draft.price);
  if (minutes === null || price === null) return null;
  const item = { id: pkg === "new" ? "draft" : pkg.id, name: draft.name.trim() || COPY.preview, minutes, price_zar: price };
  const shelf = shelfWith(active ?? [], draft.shelf, item);
  const baseline = baselineOf(shelf);
  const saving = savingOf(item, baseline);
  const hourly = perHour(price, minutes);
  let line: string = COPY.previewAlone;
  if (shelf.length > 1 && baseline) {
    // Joined, not a nested template literal: lizard loses its place inside one and swallows the file.
    const base = baseline.name + " (" + formatMoney(baseline.price_zar) + ")";
    line = baseline.id === item.id ? COPY.previewIsBaseline : saving ? COPY.previewSaves(saving.zar, saving.pct, base) : COPY.previewNoSaving(base);
  }
  return (
    <section aria-label={COPY.preview} aria-live="polite" className="flex flex-col gap-1 rounded-xl border border-border bg-bg-muted p-4 text-sm" data-package-preview="">
      <p className="font-semibold text-text-primary">
        <Minutes value={minutes} /> · <span className="tabular-nums">{formatMoney(price)}</span>
        {hourly !== null ? <span className="font-normal text-text-secondary"> · {COPY.perHour(hourly)}</span> : null}
      </p>
      <p className="text-text-secondary">{line}</p>
    </section>
  );
}
