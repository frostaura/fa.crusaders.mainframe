import { useState } from "react";
import { Alert } from "../Alert";
import { Button, Input, Label } from "../Button";
import { Card } from "../Card";
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

  return (
    <Card className="space-y-5">
      <h2 className="text-lg font-semibold">{`Editing ${group.name}`}</h2>

      {error != null && <Alert tone="danger">{explainGroupRefusal(error)}</Alert>}

      <div className="space-y-1">
        <Label htmlFor="group-name">Name</Label>
        <Input
          id="group-name" className="min-h-11" value={draft.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="group-description">Description</Label>
        <p className="text-sm text-text-muted">Members see this on the booking grid, so keep it short.</p>
        <Input
          id="group-description" className="min-h-11" value={draft.description}
          onChange={(e) => set("description", e.target.value)}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text-primary">What does a slot cost this group?</legend>
        {GROUP_PRICING_MODES.map((mode) => (
          <label key={mode} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio" name="group-pricing" className="h-5 w-5" value={mode}
              checked={draft.mode === mode}
              onChange={() => set("mode", mode)}
            />
            <span>{MODE_LABEL[mode]}</span>
          </label>
        ))}
        {draft.mode === "multiplier" && (
          <div className="space-y-1">
            <Label htmlFor="group-multiplier">Multiplier (× the court's price)</Label>
            <Input
              id="group-multiplier" className="min-h-11" inputMode="decimal" value={draft.multiplier}
              onChange={(e) => set("multiplier", e.target.value)}
            />
          </div>
        )}
        {draft.mode === "flat_per_slice" && (
          <div className="space-y-1">
            <Label htmlFor="group-flat">Credits per slot</Label>
            <Input
              id="group-flat" className="min-h-11" inputMode="decimal" value={draft.flatPrice}
              onChange={(e) => set("flatPrice", e.target.value)}
            />
          </div>
        )}
        <p className="text-sm font-medium text-text-primary">
          {slicePriceLine({
            mode: draft.mode,
            credits: price.credits,
            courtPrice,
            multiplierBps: Math.round(Number(draft.multiplier) * 10_000),
            unknown: price.unknown,
          })}
        </p>
        <p className="text-sm text-text-secondary">
          {ratePerBlockSentence({ creditsPerZar, blockZar, slicePrice: price.credits })}
        </p>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium text-text-primary">Limits for this group</legend>
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

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-text-primary">When may this group book?</h3>
        <WeekPainter
          club={club}
          value={draft.windows}
          onChange={(next) => set("windows", next)}
          sliceMinutes={sliceMinutes}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary" className="min-h-11" disabled={saving}
          onClick={() => onSave(bodyFrom(draft))}
        >
          {`Save ${group.name}`}
        </Button>
        <Button variant="ghost" className="min-h-11" onClick={onCancel}>
          {`Stop editing ${group.name}`}
        </Button>
      </div>
    </Card>
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
  const id = `cap-${noun.replace(/\s+/g, "-")}`;
  const inherits = value === null;
  return (
    <div className="space-y-1">
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox" className="h-5 w-5" checked={inherits}
          onChange={() => onChange(inherits ? String(clubValue ?? 0) : null)}
        />
        <span>{`Use the club's limit for ${noun}`}</span>
      </label>
      {!inherits && (
        <>
          <Label htmlFor={id}>{`${noun[0].toUpperCase()}${noun.slice(1)} for this group`}</Label>
          <Input
            id={id} className="min-h-11" inputMode="numeric" value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </>
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
