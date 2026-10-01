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
import { GroupPackages } from "./GroupPackages";
import { CAPS, bpsFromText, draftProblems, type ClubContext, type Draft, type SetDraft } from "./groupDraft";
import {
  DISCOUNT_COPY, GROUP_PACKAGES, GROUP_SECTIONS, GROUP_SHEET, PEAK_COMBINE, PEAK_OPTIONS, capResolutionSentence,
  explainGroupRefusal, membersOf, peakWindowLine, type PeakChoice,
} from "../../lib/groupsCopy";

/**
 * The group editor's sections — Basics, Package discount, Peak hours, Booking times, Limits
 * (D2 + P13: "the one place for times, caps, peak and the package discount"; groups carry no
 * prices any more — a booking costs its minutes, contract §1.1).
 *
 * <p>
 * <b>Every choice states its consequence beside itself.</b> A percentage with no sentence under it
 * is a number whose effect is invisible until a member buys a package. The consequence sentences
 * all come from `groupsCopy`, so the editor and the card cannot describe one rule two ways.
 * </p>
 *
 * <p>
 * <b>The discount is tri-state on the wire, and the draft keeps it so.</b> "No say" (null) or a
 * percentage, where 0% is a real say (lowest wins, so it takes another group's discount away).
 * A figure the club would refuse is refused at the field as it is typed, never sent.
 * </p>
 *
 * <p>
 * <b>A cap override that cannot bite is named as it is typed.</b> Under ruling 3 a group may
 * lower a cap and never raise one, so an 8 under a club limit of 4 changes nothing — and the
 * failure it would otherwise produce is the one nobody ever finds: a save that reports success.
 * </p>
 */

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
  /** The group being edited; `""` for a new one, which has no packages of its own yet. */
  groupId: string;
  draft: Draft;
  set: SetDraft;
  context: ClubContext;
  error: unknown;
  /** Show field problems — after the first Save press, never while the admin is still typing. */
  showProblems: boolean;
}) {
  const { groupId, draft, set, context, error, showProblems } = props;
  const problems = showProblems ? draftProblems(draft) : {};
  // A typed figure the club would refuse is said as it is typed; an EMPTY one only after a press.
  const typed = (draft.discount ?? "").trim() !== "";
  const discountProblem = showProblems || typed ? draftProblems(draft).discount : undefined;
  return (
    <div className="flex flex-col gap-6 pb-2" data-group-editor="">
      {error != null && <Alert tone="danger" live="assertive">{explainGroupRefusal(error)}</Alert>}
      <Basics draft={draft} set={set} problem={problems.name} />
      <Separator />
      <Section id="group-discount" title={GROUP_SECTIONS.discount} lead={DISCOUNT_COPY.combine}>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <DiscountChoice draft={draft} set={set} problem={discountProblem} />
          <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-sm text-text-secondary">
            <h4 className="font-medium text-text-primary">{GROUP_PACKAGES.title}</h4>
            {groupId ? <GroupPackages groupId={groupId} packages={context.packages} /> : <p>{GROUP_PACKAGES.newGroup}</p>}
          </div>
        </div>
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

/** The shaded "what this means" panel under a choice. */
function Consequence({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-1 rounded-lg bg-bg-muted px-3 py-2.5 text-sm", className)}>{children}</div>;
}

/**
 * The package discount: "no say" (the switch), or a percentage — with what it means for the
 * group's members under it, live, as the figure is typed. The switch is the control and the number
 * is what it reveals, because having no say is what nearly every group should do.
 */
function DiscountChoice(props: { draft: Draft; set: SetDraft; problem?: string }) {
  const { draft, set, problem } = props;
  const noSay = draft.discount === null;
  const bps = noSay ? null : bpsFromText(draft.discount ?? "");
  return (
    <div className="flex flex-col gap-3">
      <Field className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <FieldLabel>{DISCOUNT_COPY.noSay}</FieldLabel>
          <FieldDescription>{DISCOUNT_COPY.noSayHelp}</FieldDescription>
        </div>
        <Switch checked={noSay} onCheckedChange={(on) => set("discount", on ? null : "")} />
      </Field>
      {!noSay && (
        <Field invalid={Boolean(problem)} className="max-w-xs">
          <FieldLabel>{DISCOUNT_COPY.field}</FieldLabel>
          <Input
            inputMode="decimal"
            autoComplete="off"
            value={draft.discount ?? ""}
            onChange={(e) => set("discount", e.target.value)}
            className="font-semibold tabular-nums"
          />
          <FieldDescription>{DISCOUNT_COPY.fieldHelp}</FieldDescription>
          <FieldError>{problem}</FieldError>
        </Field>
      )}
      {noSay || bps !== null ? (
        <Consequence>
          <p className="font-semibold text-accent-strong" data-discount-preview="">{DISCOUNT_COPY.preview(bps)}</p>
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
      : `${membersOf(groupName)} get ${groupValue} ${noun}. The club's system hasn't said what everybody else gets.`;
  }
  if (groupValue === null) return `${membersOf(groupName)} get the club's ${clubValue} ${noun}.`;
  if (clubValue > 0 && groupValue >= clubValue) {
    return `${membersOf(groupName)} get ${clubValue} ${noun} — the club's own limit. A group can `
      + `lower that and never raise it, so ${groupValue} would change nothing.`;
  }
  return `${membersOf(groupName)} get ${groupValue} ${noun}. Everyone else gets the club's ${clubValue}.`;
}
