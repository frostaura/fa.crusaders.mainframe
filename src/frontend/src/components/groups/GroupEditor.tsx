import { useEffect, useRef, useState } from "react";
import { Alert } from "../Alert";
import { Button } from "../ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { RadioCard, RadioGroup } from "../ui/radio-group";
import { Switch } from "../ui/switch";
import { typography } from "../../lib/typography";
import { WeekPainter } from "./WeekPainter";
import { paintedToWindows, windowsToPainted } from "./weekGrid";
import { GROUP_PRICING_MODES, type GroupPricingMode, type MemberGroup, type MemberGroupBody } from "../../lib/adminApi";
import { round2AwayFromZero } from "../../lib/groupRules";
import {
  capResolutionSentence, explainGroupRefusal, ratePerBlockSentence, slicePriceLine,
  type PaintedWeek,
} from "../../lib/groupsCopy";

/**
 * The group editor — name, what a slot costs, the three caps, and the weekly painter.
 *
 * <p>
 * <b>Every choice states its consequence beside itself.</b> Three radio buttons with no figure
 * next to them are three buttons a volunteer admin guesses at; a cap stepper with no sentence
 * under it is a number whose effect is invisible until a member complains. The consequence
 * sentences all come from `groupsCopy`, so the editor and the card cannot describe one rule two
 * ways.
 * </p>
 *
 * <p>
 * <b>A cap override that cannot bite is named as it is typed.</b> Under ruling 3 a group may
 * lower a cap and never raise one, so an 8 under a club limit of 4 changes nothing — and the
 * failure it would otherwise produce is the one nobody ever finds: a save that reports success.
 * </p>
 */

const MODE_LABEL: Record<GroupPricingMode, string> = {
  inherit_court: "The court's own price",
  multiplier: "A multiple of the court's price",
  flat_per_slice: "A flat price per slot",
};

/** Which caps exist, how they are labelled, and what the club's own value for each is called. */
const CAPS = [
  { key: "maxSlotsPerDay", wire: "max_slots_per_day", noun: "slots a day", club: "slotCap" },
  { key: "maxMinutesPerDay", wire: "max_minutes_per_day", noun: "minutes a day", club: "minuteCap" },
  { key: "advanceBookingDays", wire: "advance_booking_days", noun: "days ahead", club: "advanceDays" },
] as const;

type Draft = {
  name: string;
  description: string;
  mode: GroupPricingMode;
  /** Typed as a decimal multiple — 0.75, not 7500. Converted to basis points on the way out. */
  multiplier: string;
  flatPrice: string;
  caps: Record<string, string | null>;
  windows: PaintedWeek;
};

function draftFrom(group: MemberGroup): Draft {
  const caps: Record<string, string | null> = {};
  for (const cap of CAPS) {
    const own = group.caps?.[cap.wire];
    caps[cap.key] = typeof own === "number" ? String(own) : null;
  }
  return {
    name: group.name,
    description: group.description ?? "",
    mode: group.pricing?.mode ?? "inherit_court",
    multiplier: String(Number(((group.pricing?.multiplier_bps ?? 10_000) / 10_000).toFixed(4))),
    flatPrice: group.pricing?.flat_slice_price_credits == null
      ? "" : String(group.pricing.flat_slice_price_credits),
    caps,
    windows: windowsToPainted(group.windows),
  };
}

/** What one slot costs under the choice currently on screen — the figure beside the choice. */
function priceOf(draft: Draft, courtPrice: number): { credits: number; unknown: boolean } {
  if (draft.mode === "inherit_court") return { credits: courtPrice, unknown: false };
  if (draft.mode === "multiplier") {
    const multiple = Number(draft.multiplier);
    if (!Number.isFinite(multiple)) return { credits: 0, unknown: true };
    return { credits: Math.max(0, round2AwayFromZero(courtPrice * multiple)), unknown: false };
  }
  const flat = Number(draft.flatPrice);
  if (draft.flatPrice.trim() === "" || !Number.isFinite(flat)) return { credits: 0, unknown: true };
  return { credits: Math.max(0, flat), unknown: false };
}

function bodyFrom(draft: Draft): MemberGroupBody {
  const numberOrNull = (value: string | null) =>
    value === null || value.trim() === "" ? null : Number(value);
  return {
    name: draft.name.trim(),
    description: draft.description.trim() === "" ? null : draft.description.trim(),
    pricing: {
      mode: draft.mode,
      ...(draft.mode === "multiplier"
        ? { multiplierBps: Math.round(Number(draft.multiplier) * 10_000) }
        : {}),
      ...(draft.mode === "flat_per_slice" ? { flatSlicePriceCredits: Number(draft.flatPrice) } : {}),
    },
    caps: {
      maxSlotsPerDay: numberOrNull(draft.caps.maxSlotsPerDay),
      maxMinutesPerDay: numberOrNull(draft.caps.maxMinutesPerDay),
      advanceBookingDays: numberOrNull(draft.caps.advanceBookingDays),
    },
    // Wholesale, because the API replaces them wholesale. A PATCH carrying a subset would
    // silently drop every day it left out.
    windows: paintedToWindows(draft.windows),
  };
}

export function GroupEditor({
  group, club, sliceMinutes, courtPrice, clubCaps, creditsPerZar, blockZar, saving, error,
  onSave, onCancel,
}: {
  group: MemberGroup;
  club: PaintedWeek;
  sliceMinutes: number;
  courtPrice: number;
  clubCaps: { slotCap: number | null; minuteCap: number | null; advanceDays: number | null };
  creditsPerZar: number | null | undefined;
  blockZar: number | null | undefined;
  saving: boolean;
  error: unknown;
  onSave: (body: MemberGroupBody) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(group));
  const price = priceOf(draft, courtPrice);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  // The editor opens under the list: move focus (and so the view) to its heading, or an admin
  // presses Edit and sees nothing change.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);

  return (
    <Card data-group-editor="">
      <CardHeader>
        <CardTitle asChild>
          <h2 ref={heading} tabIndex={-1} data-route-heading="">{group.id === "" ? "A new group" : `Editing ${group.name}`}</h2>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {error != null && <Alert tone="danger">{explainGroupRefusal(error)}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Input value={draft.description} onChange={(e) => set("description", e.target.value)} />
            <FieldDescription>Members see this on the booking grid, so keep it short.</FieldDescription>
          </Field>
        </div>

        <PricingChoice draft={draft} set={set} courtPrice={courtPrice} price={price} creditsPerZar={creditsPerZar} blockZar={blockZar} />

        <fieldset className="flex flex-col gap-4">
          <legend className={typography({ variant: "h3" })}>Limits for this group</legend>
          {CAPS.map((cap) => (
            <CapField
              key={cap.key}
              noun={cap.noun}
              groupName={draft.name}
              clubValue={clubCaps[cap.club]}
              value={draft.caps[cap.key]}
              onChange={(next) => set("caps", { ...draft.caps, [cap.key]: next })}
            />
          ))}
        </fieldset>

        <div className="flex flex-col gap-2">
          <h3 className={typography({ variant: "h3" })}>When may this group book?</h3>
          <WeekPainter
            club={club}
            value={draft.windows}
            onChange={(next) => set("windows", next)}
            sliceMinutes={sliceMinutes}
          />
        </div>
      </CardContent>

      <CardFooter className="justify-end">
        <Button variant="outline" onClick={onCancel}>
          Cancel{" "}<span className="sr-only">{`editing ${group.name}`}</span>
        </Button>
        <Button pending={saving} onClick={() => onSave(bodyFrom(draft))}>
          Save{" "}<span className="sr-only">{`${group.name}`}</span>
        </Button>
      </CardFooter>
    </Card>
  );
}

/** What a slot costs: three cards, the figure for the choice on screen stated under them. */
function PricingChoice(props: {
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  courtPrice: number;
  price: { credits: number; unknown: boolean };
  creditsPerZar: number | null | undefined;
  blockZar: number | null | undefined;
}) {
  const { draft, set, courtPrice, price, creditsPerZar, blockZar } = props;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className={typography({ variant: "h3" })}>What does a slot cost this group?</legend>
      <RadioGroup
        value={draft.mode}
        onValueChange={(mode) => set("mode", mode as GroupPricingMode)}
        className="grid gap-2 sm:grid-cols-3"
        aria-label="What does a slot cost this group?"
      >
        {GROUP_PRICING_MODES.map((mode) => <RadioCard key={mode} value={mode} title={MODE_LABEL[mode]} />)}
      </RadioGroup>
      {draft.mode === "multiplier" && (
        <Field className="max-w-xs">
          <FieldLabel>Multiplier (× the court&apos;s price)</FieldLabel>
          <Input inputMode="decimal" value={draft.multiplier} onChange={(e) => set("multiplier", e.target.value)} />
        </Field>
      )}
      {draft.mode === "flat_per_slice" && (
        <Field className="max-w-xs">
          <FieldLabel>Credits per slot</FieldLabel>
          <Input inputMode="decimal" value={draft.flatPrice} onChange={(e) => set("flatPrice", e.target.value)} />
        </Field>
      )}
      <div className="rounded-lg bg-bg-muted px-3 py-2.5 text-sm">
        <p className="font-medium text-text-primary">
          {slicePriceLine({
            mode: draft.mode,
            credits: price.credits,
            courtPrice,
            multiplierBps: Math.round(Number(draft.multiplier) * 10_000),
            unknown: price.unknown,
          })}
        </p>
        <p className="text-text-secondary">
          {ratePerBlockSentence({ creditsPerZar, blockZar, slicePrice: price.credits })}
        </p>
      </div>
    </fieldset>
  );
}

/**
 * One cap, behind a "use the club's limit" checkbox, with the resolution stated under it.
 *
 * The checkbox is the control and the number is what it reveals, rather than the other way
 * round, because inheriting is what nearly every group should do and a blank number field reads
 * as a field somebody forgot to fill in.
 */
function CapField({ noun, groupName, clubValue, value, onChange }: {
  noun: string;
  groupName: string;
  clubValue: number | null;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const inherits = value === null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <Field className="flex items-center justify-between gap-3">
        <FieldLabel className="font-normal">{`Use the club's limit for ${noun}`}</FieldLabel>
        <Switch checked={inherits} onCheckedChange={() => onChange(inherits ? String(clubValue ?? 0) : null)} />
      </Field>
      {!inherits && (
        <Field className="max-w-xs">
          <FieldLabel>{`${noun[0].toUpperCase()}${noun.slice(1)} for this group`}</FieldLabel>
          <Input inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} />
        </Field>
      )}
      <p className="text-sm text-text-secondary">
        {noun === "slots a day"
          ? capResolutionSentence(groupName, inherits ? null : Number(value), clubValue)
          : inheritanceLine(groupName, noun, inherits ? null : Number(value), clubValue)}
      </p>
    </div>
  );
}

/** The same shape as the slots sentence for the two caps item 19 does not name. */
function inheritanceLine(
  groupName: string, noun: string, groupValue: number | null, clubValue: number | null,
): string {
  if (clubValue === null) {
    return groupValue === null
      ? `The club's system hasn't said a limit on ${noun}, and ${groupName} doesn't set one either.`
      : `${groupName} members get ${groupValue} ${noun}. The club's system hasn't said what everybody else gets.`;
  }
  if (groupValue === null) return `${groupName} members get the club's ${clubValue} ${noun}.`;
  if (clubValue > 0 && groupValue >= clubValue) {
    return `${groupName} members get ${clubValue} ${noun} — the club's own limit. A group can `
      + `lower that and never raise it, so ${groupValue} would change nothing.`;
  }
  return `${groupName} members get ${groupValue} ${noun}. Everyone else gets the club's ${clubValue}.`;
}
