import type { ReactNode } from "react";
import { Alert } from "../Alert";
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { RadioCard, RadioGroup } from "../ui/radio-group";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { typography } from "../../lib/typography";
import { cn } from "../../lib/utils";
import { WeekPainter } from "./WeekPainter";
import { CAPS, draftProblems, pricesOf, type ClubContext, type Draft, type SetDraft } from "./groupDraft";
import { GROUP_PRICING_MODES, type GroupPricingMode } from "../../lib/adminApi";
import { rateProblem } from "../../lib/groupRules";
import {
  GROUP_SECTIONS, GROUP_SHEET, PEAK_COMBINE, PEAK_OPTIONS, RATE_COPY, capResolutionSentence,
  explainGroupRefusal, peakWindowLine, ratePerBlockSentence, ratePreviewLine, slicePriceLine,
  type PeakChoice,
} from "../../lib/groupsCopy";

/**
 * The group editor's sections — Basics, Court price, Top-up rate, Peak hours, Booking times,
 * Limits (D2: "the one place for pricing, times, caps, peak and the top-up rate").
 *
 * <p>
 * <b>Every choice states its consequence beside itself.</b> Three radio buttons with no figure
 * next to them are three buttons a volunteer admin guesses at; a rate field with no "R100 → 240 cr"
 * under it is a number whose effect is invisible until a member tops up. The consequence
 * sentences all come from `groupsCopy`, so the editor and the card cannot describe one rule two
 * ways.
 * </p>
 *
 * <p>
 * <b>Both D2 fields are tri-state on the wire, and the draft keeps them so.</b> A rate is
 * "inherit the club's" (null) or a figure; a peak say is grants / withholds / no say. The body
 * always sends both — the PATCH distinguishes absent from null, and a draft that dropped an
 * unchanged field would be indistinguishable from one that meant "unchanged" by accident.
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

/** One titled part of the sheet: an h3, a line saying what it decides, then its controls. */
function Section({ id, title, lead, children }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 id={id} className={typography({ variant: "h3" })}>{title}</h3>
        {lead ? <p className="text-sm text-text-secondary">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function GroupEditorSections(props: {
  draft: Draft;
  set: SetDraft;
  context: ClubContext;
  error: unknown;
  /** Show field problems — after the first Save press, never while the admin is still typing. */
  showProblems: boolean;
}) {
  const { draft, set, context, error, showProblems } = props;
  const problems = showProblems ? draftProblems(draft) : {};
  return (
    <div className="flex flex-col gap-6 pb-2" data-group-editor="">
      {error != null && <Alert tone="danger" live="assertive">{explainGroupRefusal(error)}</Alert>}
      <Basics draft={draft} set={set} problem={problems.name} />
      <Separator />
      <Section id="group-price" title={GROUP_SECTIONS.price}>
        <PricingChoice draft={draft} set={set} context={context} />
      </Section>
      <Separator />
      <Section id="group-rate" title={GROUP_SECTIONS.rate} lead={RATE_COPY.combine}>
        <RateChoice draft={draft} set={set} context={context} problem={problems.rate} />
      </Section>
      <Separator />
      <Section id="group-peak" title={GROUP_SECTIONS.peak} lead={peakWindowLine(context.peakHours, context.peakAdvanceHours)}>
        <PeakChoiceCards draft={draft} set={set} />
      </Section>
      <Separator />
      <Section id="group-times" title={GROUP_SECTIONS.times}>
        <WeekPainter club={context.club} value={draft.windows} onChange={(next) => set("windows", next)} sliceMinutes={context.sliceMinutes} />
      </Section>
      <Separator />
      <Section id="group-limits" title={GROUP_SECTIONS.limits}>
        <div className="grid gap-3 lg:grid-cols-3">
          {CAPS.map((cap) => (
            <CapField
              key={cap.key}
              noun={cap.noun}
              groupName={draft.name || "This group"}
              clubValue={context.clubCaps[cap.club]}
              value={draft.caps[cap.key]}
              onChange={(next) => set("caps", { ...draft.caps, [cap.key]: next })}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

function Basics({ draft, set, problem }: { draft: Draft; set: SetDraft; problem?: string }) {
  return (
    <Section id="group-basics" title={GROUP_SECTIONS.basics}>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field invalid={Boolean(problem)}>
          <FieldLabel>{GROUP_SHEET.nameLabel}</FieldLabel>
          <Input value={draft.name} autoComplete="off" onChange={(e) => set("name", e.target.value)} />
          <FieldError>{problem}</FieldError>
        </Field>
        <Field>
          <FieldLabel>{GROUP_SHEET.descriptionLabel}</FieldLabel>
          <Textarea rows={2} value={draft.description} onChange={(e) => set("description", e.target.value)} />
          <FieldDescription>{GROUP_SHEET.descriptionHelp}</FieldDescription>
        </Field>
      </div>
    </Section>
  );
}

/** What a slot costs: three cards, the figure for the choice on screen stated under them. */
function PricingChoice({ draft, set, context }: { draft: Draft; set: SetDraft; context: ClubContext }) {
  const price = pricesOf(draft, context.courtPrices);
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup
        value={draft.mode}
        onValueChange={(mode) => set("mode", mode as GroupPricingMode)}
        className="grid gap-2 md:grid-cols-3"
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
      <Consequence>
        <p className="font-medium text-text-primary">
          {slicePriceLine({
            mode: draft.mode,
            credits: price.credits,
            courtPrices: context.courtPrices,
            multiplierBps: Math.round(Number(draft.multiplier) * 10_000),
            unknown: price.unknown,
          })}
        </p>
      </Consequence>
    </div>
  );
}

/** The prices a top-up block is divided by — null when any of them is not known yet. */
function blockPrices(draft: Draft, context: ClubContext): number[] | null {
  const price = pricesOf(draft, context.courtPrices);
  return price.unknown || price.credits.length === 0 ? null : price.credits;
}

/** The shaded "what this means" panel under a choice. */
function Consequence({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-1 rounded-lg bg-bg-muted px-3 py-2.5 text-sm", className)}>{children}</div>;
}

/**
 * The top-up rate: inherit the club's (the switch), or a figure — with what one block buys at it,
 * live, as the figure is typed. The switch is the control and the number is what it reveals,
 * because inheriting is what nearly every group should do.
 */
function RateChoice(props: { draft: Draft; set: SetDraft; context: ClubContext; problem?: string }) {
  const { draft, set, context, problem } = props;
  const inherits = draft.rate === null;
  const typed = draft.rate === null ? null : rateProblem(draft.rate) === null ? Number(draft.rate.trim()) : null;
  const effective = inherits ? context.clubRate : typed;
  return (
    <div className="flex flex-col gap-3">
      <Field className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <FieldLabel>{RATE_COPY.inherit}</FieldLabel>
          <FieldDescription>{RATE_COPY.inheritHelp(context.clubRate)}</FieldDescription>
        </div>
        <Switch
          checked={inherits}
          onCheckedChange={(on) => set("rate", on ? null : String(context.clubRate ?? ""))}
        />
      </Field>
      {!inherits && (
        <Field invalid={Boolean(problem)} className="max-w-xs">
          <FieldLabel>{RATE_COPY.field()}</FieldLabel>
          <Input
            inputMode="decimal"
            autoComplete="off"
            value={draft.rate ?? ""}
            onChange={(e) => set("rate", e.target.value)}
            className="font-semibold tabular-nums"
          />
          <FieldError>{problem}</FieldError>
        </Field>
      )}
      {typeof effective === "number" ? (
        <Consequence>
          <p className="text-lg font-semibold tabular-nums text-accent-strong" data-rate-preview="">
            {ratePreviewLine(effective, context.blockZar)}
          </p>
          <p className="text-text-secondary">
            {ratePerBlockSentence({ creditsPerZar: effective, blockZar: context.blockZar ?? 100, slicePrices: blockPrices(draft, context) })}
          </p>
        </Consequence>
      ) : null}
    </div>
  );
}

/** Grants / Withholds / No say — three cards, and how several groups combine, said once. */
function PeakChoiceCards({ draft, set }: { draft: Draft; set: SetDraft }) {
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup
        value={draft.peak}
        onValueChange={(next) => set("peak", next as PeakChoice)}
        className="grid gap-2 md:grid-cols-3"
        aria-label={GROUP_SECTIONS.peak}
      >
        {PEAK_OPTIONS.map((option) => (
          <RadioCard key={option.value} value={option.value} title={option.title} description={option.description} />
        ))}
      </RadioGroup>
      <Consequence><p className="text-text-secondary">{PEAK_COMBINE}</p></Consequence>
    </div>
  );
}

/**
 * One cap, behind a "use the club's limit" switch, with the resolution stated under it.
 *
 * The switch is the control and the number is what it reveals, rather than the other way
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
        <Field>
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
