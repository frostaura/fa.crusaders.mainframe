import { useState, type ReactNode } from "react";
import { ActionsMenu } from "../admin/ActionsMenu";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { REQUIRED_MARK } from "../../lib/confirmDialogCopy";
import {
  Archive, ArrowCounterClockwise, CalendarDots, Clock, Coins, Lightning, Lock, PencilSimple, SlidersHorizontal, Tag, Trash, Users,
} from "../ui/icons";
import { Textarea } from "../ui/textarea";
import { priceForGroup } from "../../lib/groupRules";
import {
  ARCHIVE_COPY, GROUP_ACTIONS, GROUP_LOST, GROUP_REFUSAL_CODES, SYSTEM_GROUP, capsSummary, creditsRange, memberCountLine,
  paintedWeekSentence, peakChip, rateChip, ratePreviewLine, slicePriceLine, type PaintedWeek,
} from "../../lib/groupsCopy";
import { unsureSentence } from "../../lib/lostReply";
import { windowsToPainted } from "./weekGrid";
import type { MemberGroup } from "../../lib/adminApi";

/**
 * One group, summarised in the facts an admin opens this page for — what a slot costs, what a
 * top-up buys, whether it touches peak hours, when it may book, and its limits.
 *
 * <p>
 * <b>What it costs and when it applies are on the CARD, not behind the editor.</b> A list of
 * group names tells an admin nothing they did not already know; the reason to come here is to
 * find out which rule is doing the thing somebody has complained about, and that answer has to
 * be readable without opening anything. The rate and the peak say are chips (icon + words, never
 * colour alone) because they are the two things D2 moved here from the member class.
 * </p>
 *
 * <p>
 * <b>Archive asks why; the built-in group offers neither archive nor delete — absent, not
 * disabled.</b> An archive changes what every member of the group pays and may book, so it
 * needs words for the change record. The league group carries the club's rates and the server
 * refuses both (409 `group_is_system_default`); a disabled control invites an admin to work out
 * how to enable it, and this one never can be — the sentence under the card says why.
 * </p>
 */
export function GroupCard(props: {
  group: MemberGroup;
  club: PaintedWeek;
  sliceMinutes: number;
  /** The distinct prices of the courts in use; null while unread (F3.3). */
  courtPrices: readonly number[] | null;
  clubRate: number | null | undefined;
  blockZar: number | null | undefined;
  onEdit: () => void;
  onMembers: () => void;
  onPreview: () => void;
  onArchive: (reason: string) => Promise<void>;
  onRestore: () => Promise<void>;
  onDelete: () => void | string | Promise<void | string>;
}) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { group } = props;
  const [archiving, setArchiving] = useState(false);
  const archived = group.status === "archived";
  const builtIn = Boolean(group.system_key);

  return (
    // Muted by its surface, never its ink (R5 X5-6): `opacity-80` faded the text with the card and
    // the Archived badge fell to 3.24:1. A dashed edge and the muted fill say "set aside" instead.
    <Card data-group-card={group.id} className={archived ? "border-dashed bg-bg-muted shadow-none" : undefined}>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle asChild><h2>{group.name}</h2></CardTitle>
          {builtIn ? <Badge tone="info" icon={<Lock size={14} weight="bold" aria-hidden="true" />}>{SYSTEM_GROUP.badge}</Badge> : null}
          {!builtIn && group.is_system_default ? <Badge tone="info">Standing group</Badge> : null}
          {archived ? <Badge tone="warning" icon={<Archive size={14} weight="bold" aria-hidden="true" />}>Archived</Badge> : null}
        </div>
        <CardDescription>
          {memberCountLine(group.member_count)}
          {group.description ? ` · ${group.description}` : ""}
        </CardDescription>
        <CardAction>
          <ActionsMenu
            label={GROUP_ACTIONS.more(group.name)}
            items={[
              !archived && !builtIn && {
                label: GROUP_ACTIONS.archive,
                icon: <Archive size={16} aria-hidden="true" />,
                onSelect: () => setArchiving(true),
              },
              archived && {
                label: ARCHIVE_COPY.restore,
                icon: <ArrowCounterClockwise size={16} aria-hidden="true" />,
                onSelect: () => void props.onRestore(),
              },
              !group.is_system_default && !builtIn && {
                label: GROUP_ACTIONS.remove,
                icon: <Trash size={16} aria-hidden="true" />,
                danger: true,
                confirm: {
                  title: GROUP_ACTIONS.removeTitle(group.name),
                  description: GROUP_ACTIONS.removeBody(group.name),
                  confirmLabel: GROUP_ACTIONS.remove,
                  onConfirm: props.onDelete,
                },
              },
            ]}
          />
        </CardAction>
      </CardHeader>

      {/* `flex-1`: two cards side by side are one grid row, equally tall, and the footer's
          actions sit on the same line in both (VIS F3-15: they were at different heights). */}
      <CardContent className="flex flex-1 flex-col gap-4 text-sm">
        <ul aria-label={`${group.name} at a glance`} className="flex flex-wrap gap-1.5">
          <li><Badge tone={group.credits_per_zar == null ? "neutral" : "info"} icon={<Coins size={14} weight="bold" aria-hidden="true" />}>{rateChip(group.credits_per_zar)}</Badge></li>
          <li><Badge tone={group.peak_priority === true ? "success" : group.peak_priority === false ? "warning" : "neutral"} icon={<Lightning size={14} weight="bold" aria-hidden="true" />}>{peakChip(group.peak_priority)}</Badge></li>
        </ul>
        <GroupFacts {...props} />
        {builtIn ? <p className="text-text-muted">{SYSTEM_GROUP.note(group.name)}</p> : null}
        {!builtIn && group.is_system_default ? <p className="text-text-muted">{GROUP_ACTIONS.standing(group.name)}</p> : null}
      </CardContent>

      <CardFooter className="flex-wrap">
        <Button variant="secondary" onClick={props.onEdit} icon={<PencilSimple aria-hidden="true" />}>
          {GROUP_ACTIONS.edit}{" "}<span className="sr-only">{`${group.name}`}</span>
        </Button>
        <Button variant="outline" onClick={props.onMembers} icon={<Users aria-hidden="true" />}>
          {GROUP_ACTIONS.members}{" "}<span className="sr-only">{`of ${group.name}`}</span>
        </Button>
        <Button variant="outline" onClick={props.onPreview} icon={<CalendarDots aria-hidden="true" />}>
          {GROUP_ACTIONS.preview}{" "}<span className="sr-only">{`for ${group.name}`}</span>
        </Button>
      </CardFooter>

      {archiving ? (
        <ArchiveDialog
          group={group}
          open={archiving}
          onOpenChange={setArchiving}
          onArchive={props.onArchive}
        />
      ) : null}
    </Card>
  );
}

/** The four rules, one line each, with an icon beside each heading so a column of cards scans. */
function GroupFacts(props: Parameters<typeof GroupCard>[0]) {
  const { group, club, sliceMinutes, courtPrices, clubRate, blockZar } = props;
  const mode = group.pricing?.mode ?? "inherit_court";
  // Flat needs no court price; the other two are worked out once per court price.
  const each = mode === "flat_per_slice" ? [priceForGroup(group, 0)] : (courtPrices ?? []).map((p) => priceForGroup(group, p));
  const unknown = each.some((p) => p === null);
  const prices = each.filter((p): p is number => p !== null);
  const positive = prices.filter((p) => p > 0);
  const rate = typeof group.credits_per_zar === "number" ? group.credits_per_zar : clubRate;
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <Fact icon={<Tag size={16} aria-hidden="true" />} term="Court price">
        {slicePriceLine({
          mode,
          credits: prices,
          courtPrices,
          multiplierBps: group.pricing?.multiplier_bps,
          unknown,
        })}
      </Fact>
      <Fact icon={<Coins size={16} aria-hidden="true" />} term="Top-up">
        {typeof rate === "number"
          ? `${ratePreviewLine(rate, blockZar)}${!unknown && positive.length > 0 ? ` · ${creditsRange(positive)} cr a slot` : ""}`
          : "The club's system hasn't said what a top-up buys."}
      </Fact>
      <Fact icon={<Clock size={16} aria-hidden="true" />} term="Booking times">
        {paintedWeekSentence(windowsToPainted(group.windows), club, sliceMinutes)}
      </Fact>
      <Fact icon={<SlidersHorizontal size={16} aria-hidden="true" />} term="Limits">
        {capsSummary(group.caps)}
      </Fact>
    </dl>
  );
}

function Fact({ icon, term, children }: { icon: ReactNode; term: string; children: ReactNode }) {
  return (
    // dt and dd are the wrapper's DIRECT children (F3.22): a <dl> may group each pair in one
    // <div>, and nothing deeper — the icon lives inside the term, the value is indented under it.
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="flex items-center gap-2.5 text-xs font-medium uppercase tracking-overline text-text-muted">
        <span className="shrink-0">{icon}</span>
        {term}
      </dt>
      <dd className="break-words pl-6 text-text-secondary">{children}</dd>
    </div>
  );
}

/**
 * Archive, with the reason the change record needs. Refused while the reason is empty; a refusal
 * from the club stays in the dialog, as a sentence, with the dialog open.
 */
function ArchiveDialog(props: {
  group: MemberGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: (reason: string) => Promise<void>;
}) {
  const { group, open, onOpenChange, onArchive } = props;
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="primary"
      title={ARCHIVE_COPY.title(group.name)}
      description={ARCHIVE_COPY.body(group.name, group.member_count)}
      confirmLabel={ARCHIVE_COPY.confirm}
      // R3 A-16: enabled, and a press names the missing reason and focuses it (never a dead button).
      notReady={reason.trim() === ""}
      action={`archive ${group.name}`}
      // A lost reply read back is not a failure (R3): "still active", or "can't tell".
      describe={(error) => unsureSentence(error, GROUP_LOST.archive(group.name))}
      codes={GROUP_REFUSAL_CODES}
      onConfirm={() => onArchive(reason.trim())}
      returnFocus={() => document.querySelector<HTMLElement>(`[data-group-card="${CSS.escape(group.id)}"] [data-slot="card-action"] button`)}
    >
      <Field>
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <FieldLabel>{ARCHIVE_COPY.reasonLabel}</FieldLabel>
          <span aria-hidden="true" className="text-sm text-text-secondary">{REQUIRED_MARK}</span>
        </span>
        <Textarea rows={3} value={reason} required aria-required="true" onChange={(e) => setReason(e.target.value)} />
        <FieldDescription>{ARCHIVE_COPY.reasonHelp}</FieldDescription>
      </Field>
    </ConfirmDialog>
  );
}
