import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/Alert";
import { useToast } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { CaretDown, Check, Coins, Lightning, Plus, X } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { Textarea } from "@/components/ui/textarea";
import { useIsSmUp } from "@/components/ui/use-media-query";
import {
  adminEndpoints, type MemberGroup, type MemberGroupChip, type MemberGroupPreview, type MemberGroupsSetResult,
} from "@/lib/adminApi";
import {
  ASSIGN_COPY, explainAssignRefusal, peakChangeLine, peakChip, rateChangeLine, rateChip, rulesChangeLines, tariffLine,
} from "@/lib/groupsCopy";
import { memberDetailEndpoints } from "@/lib/memberDetailApi";
import { cn } from "@/lib/utils";

/**
 * GroupAssign — one member's groups, chosen as chips and saved WHOLE (D2, R21: "Groups instead
 * please. Class doesn't make sense").
 *
 * <p>
 * <b>Why this replaced the rate class.</b> A member's groups now decide what a slot costs them,
 * when they may book, the rate a top-up converts at, and whether they get peak hours early. So a
 * change of groups is a change of money, and it is shown BEFORE it is saved: the dialog asks the
 * club (`POST /admin/member-groups/preview`, nothing written) what the new set would resolve to and
 * says it in words — "Top-up rate 1.6 → 2.4 cr per R1 (from League)", "Gains peak priority". The
 * rule is the server's; this screen never re-derives a rate a top-up could then disagree with.
 * </p>
 *
 * <p>
 * <b>The save is the whole set</b> (`PUT /admin/members/{id}/groups`): N add/remove calls would be
 * N chances to leave somebody half-moved. An archived group the member is already in may be kept
 * (it binds nothing) and is marked; it can never be joined, so it is not offered.
 * </p>
 *
 * <p>
 * Mount-to-open, like the other dialogs on these screens: the caller renders it to open it and
 * `onClose` unmounts it, so a second opening always starts from the member's saved groups.
 * </p>
 */
export type GroupAssignProps = {
  userId: string;
  name: string;
  /** The member's groups as the screen last read them — or null, and the dialog reads them. */
  current: readonly Pick<MemberGroupChip, "id" | "name">[] | null;
  onClose: () => void;
  onSaved: (result: MemberGroupsSetResult) => void;
};

export function GroupAssign(props: GroupAssignProps) {
  const { name, onClose } = props;
  const state = useAssignState(props);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !state.saving) onClose(); }}>
      <DialogContent className="sm:max-w-lg" data-dialog="group-assign">
        <DialogHeader>
          <DialogTitle>{ASSIGN_COPY.title(name)}</DialogTitle>
          <DialogDescription>{ASSIGN_COPY.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5 pb-4">
          <StateBlock
            loading={state.groups === null && !state.readError}
            error={state.groups === null ? state.readError : null}
            action={ASSIGN_COPY.loadAction}
            onRetry={() => void state.read()}
            skeleton={<div className="flex flex-col gap-2"><Skeleton className="h-touch" /><Skeleton className="h-16" /></div>}
          >
            {state.groups ? <AssignBody state={state} /> : null}
          </StateBlock>
          {state.saveError ? <Alert tone="danger" live="assertive">{explainAssignRefusal(state.saveError)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={state.saving}>Cancel</Button>
          </DialogClose>
          <Button
            pending={state.saving}
            disabled={state.groups === null || !state.changed}
            onClick={() => void state.save()}
          >
            {state.changed ? ASSIGN_COPY.saveLabel(firstWord(name), state.selected.length) : ASSIGN_COPY.unchanged}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type AssignState = ReturnType<typeof useAssignState>;

/** First word, for "Put Ada in 2 groups". No regex literal: lizard's lexer loses its place in one. */
function firstWord(name: string): string {
  return name.trim().split(" ").filter(Boolean)[0] || name;
}

type KnownGroup = Pick<MemberGroupChip, "id" | "name">;
type Known = readonly KnownGroup[];

/** The club's groups and the member's own — the latter read here only when the caller has none. */
function useAssignReads(userId: string, current: Known | null) {
  // Held from mount: a caller that passes a fresh array each render must not re-run the read.
  const [given] = useState(current);
  const [groups, setGroups] = useState<MemberGroup[] | null>(null);
  const [known, setKnown] = useState<Known | null>(given);
  const [readError, setReadError] = useState<unknown>(null);
  const read = useCallback(async () => {
    setReadError(null);
    try {
      const [club, mine] = await Promise.all([
        adminEndpoints.memberGroups(),
        given ? Promise.resolve(null) : memberDetailEndpoints.detail(userId),
      ]);
      if (mine) setKnown(mine.groups ?? []);
      setGroups(club.groups ?? []);
    } catch (err) {
      setReadError(err);
    }
  }, [userId, given]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; the state is set when the read answers
  useEffect(() => { void read(); }, [read]);
  return { groups: known ? groups : null, known: known ?? [], readError, read };
}

/** The club's groups, the chosen set, the preview of what it changes, and the save. */
function useAssignState({ userId, name, current, onSaved, onClose }: GroupAssignProps) {
  const toast = useToast();
  const reads = useAssignReads(userId, current);
  const initial = reads.known.map((g) => g.id);
  // The admin's picks, or null for "still the member's own" — so a set read after mount is used.
  const [picked, setPicked] = useState<string[] | null>(null);
  const selected = picked ?? initial;
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  const changed = !sameSet(selected, initial);
  const preview = usePreview(userId, selected, changed);

  const toggle = (id: string) => {
    setSaveError(null);
    setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await adminEndpoints.memberGroupsSet(userId, { groupIds: selected, reason });
      const rateGroup = result.groups.find((g) => g.id === result.tariff.rate_group_id)?.name ?? null;
      toast.push({ tone: "success", text: `${ASSIGN_COPY.saved(name, result.groups.length)} ${tariffLine(result.tariff, rateGroup)}.` });
      onSaved(result);
      onClose();
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  return {
    groups: reads.groups, readError: reads.readError, read: reads.read, known: reads.known,
    selected, toggle, changed, preview, reason, setReason, saving, saveError, save,
  };
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * An answer, and the set it answers. Named rather than written inline in `useState<…>`: lizard's
 * .tsx lexer reads a `<` followed by braces as a JSX tag and swallows the rest of the file.
 */
type KeyedPreview = { key: string; state: PreviewState };

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: MemberGroupPreview }
  | { status: "failed" };

/**
 * What the chosen set WOULD resolve to — asked of the club each time the set changes, the answer
 * to an older question dropped. Nothing is written by it.
 */
function usePreview(userId: string, selected: string[], changed: boolean): PreviewState {
  const key = selected.join(",");
  const [answer, setAnswer] = useState<KeyedPreview | null>(null);
  useEffect(() => {
    if (!changed) return undefined;
    let live = true;
    const timer = window.setTimeout(() => {
      adminEndpoints.memberGroupPreview({ userId, proposedGroupIds: key ? key.split(",") : [] })
        .then((preview) => { if (live) setAnswer({ key, state: { status: "ready", preview } }); })
        .catch(() => { if (live) setAnswer({ key, state: { status: "failed" } }); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [userId, key, changed]);
  if (!changed) return { status: "idle" };
  return answer?.key === key ? answer.state : { status: "loading" };
}

function AssignBody({ state }: { state: AssignState }) {
  const groups = state.groups ?? [];
  return (
    <>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-text-primary">{ASSIGN_COPY.label}</span>
        <SelectedChips state={state} groups={groups} />
        <GroupPicker state={state} groups={groups} />
      </div>
      <TariffPreview state={state.preview} groups={groups} />
      <Field>
        <FieldLabel>{ASSIGN_COPY.reasonLabel}</FieldLabel>
        <Textarea rows={2} value={state.reason} onChange={(e) => state.setReason(e.target.value)} />
        <FieldDescription>{ASSIGN_COPY.reasonHelp}</FieldDescription>
      </Field>
    </>
  );
}

/** A name for an id — from the club's list, else the name the screen was opened with. */
function nameFor(id: string, groups: MemberGroup[], known: AssignState["known"]): string {
  return groups.find((g) => g.id === id)?.name ?? known.find((g) => g.id === id)?.name ?? "A group the club no longer has";
}

function SelectedChips({ state, groups }: { state: AssignState; groups: MemberGroup[] }) {
  if (state.selected.length === 0) return <p className="text-sm text-text-muted">{ASSIGN_COPY.none}</p>;
  return (
    <ul aria-label="Chosen groups" className="flex flex-wrap gap-2">
      {state.selected.map((id) => {
        const name = nameFor(id, groups, state.known);
        const archived = groups.find((g) => g.id === id)?.status === "archived";
        return (
          <li key={id}>
            <Badge tone={archived ? "warning" : "info"} className="gap-0 py-0 pl-3 pr-0 text-sm">
              {name}
              {archived ? <span className="sr-only">{` (${ASSIGN_COPY.archived})`}</span> : null}
              <IconButton label={ASSIGN_COPY.remove(name)} size="icon-sm" className="ml-0.5" onClick={() => state.toggle(id)}>
                <X aria-hidden="true" />
              </IconButton>
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The combobox: a labelled trigger opening a searchable list of the club's groups, each a toggle
 * with a check — a Popover from `sm` up, a full-height sheet on a phone (member-combobox's shape).
 * It stays open while several are ticked; Escape or a click away closes it.
 */
function GroupPicker({ state, groups }: { state: AssignState; groups: MemberGroup[] }) {
  const [open, setOpen] = useState(false);
  const wide = useIsSmUp();
  const offered = groups.filter((g) => g.status !== "archived" || state.selected.includes(g.id));
  const trigger = (
    <Button
      variant="outline"
      role="combobox"
      aria-label={ASSIGN_COPY.add}
      aria-haspopup="dialog"
      aria-expanded={open}
      icon={<Plus aria-hidden="true" />}
      className="w-full justify-start sm:w-auto"
    >
      {ASSIGN_COPY.add}
      <CaretDown size={16} aria-hidden="true" className="ml-auto" />
    </Button>
  );
  const list = <GroupOptions groups={offered} selected={state.selected} onToggle={state.toggle} />;
  if (wide) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">{list}</PopoverContent>
      </Popover>
    );
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent size="full" guardTyped={false} aria-describedby={undefined}>
        <SheetHeader><SheetTitle>{ASSIGN_COPY.add}</SheetTitle></SheetHeader>
        <div className="min-h-0 flex-1">{list}</div>
      </SheetContent>
    </Sheet>
  );
}

function GroupOptions({ groups, selected, onToggle }: { groups: MemberGroup[]; selected: string[]; onToggle: (id: string) => void }) {
  return (
    <Command label={ASSIGN_COPY.search} className="rounded-xl">
      <CommandInput placeholder={ASSIGN_COPY.search} />
      <CommandList className="max-h-72 overflow-y-auto p-1">
        <CommandEmpty className="px-3 py-4 text-sm text-text-muted">{ASSIGN_COPY.empty}</CommandEmpty>
        {groups.map((group) => (
          <GroupOption key={group.id} group={group} on={selected.includes(group.id)} onToggle={onToggle} />
        ))}
      </CommandList>
    </Command>
  );
}

/** One group in the picker: a toggle with a check, its rate and its peak say under the name. */
function GroupOption({ group, on, onToggle }: { group: MemberGroup; on: boolean; onToggle: (id: string) => void }) {
  return (
    <CommandItem
      value={group.id}
      keywords={[group.name]}
      onSelect={() => onToggle(group.id)}
      aria-selected={on}
      data-checked={on || undefined}
    >
      <Check size={16} aria-hidden="true" className={cn("shrink-0 text-accent-strong", on ? "opacity-100" : "opacity-0")} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-text-primary">{group.name}</span>
        <span className="flex flex-wrap items-center gap-x-3 text-xs text-text-muted">
          <span className="inline-flex items-center gap-1"><Coins size={12} aria-hidden="true" />{rateChip(group.credits_per_zar)}</span>
          <span className="inline-flex items-center gap-1"><Lightning size={12} aria-hidden="true" />{peakChip(group.peak_priority)}</span>
          {group.status === "archived" ? <span>{ASSIGN_COPY.archivedHint}</span> : null}
        </span>
      </span>
    </CommandItem>
  );
}

/**
 * What the chosen set changes — the club's answer, in words. Loading is a line of skeleton, not
 * the old figures under a heading that claims they are the new ones; a failed preview says so and
 * leaves Save enabled, because the save's own answer will say what happened.
 */
function TariffPreview({ state, groups }: { state: PreviewState; groups: MemberGroup[] }) {
  if (state.status === "idle") return null;
  return (
    <section aria-label={ASSIGN_COPY.whatChanges} aria-live="polite" aria-busy={state.status === "loading"} className="flex flex-col gap-2 rounded-lg bg-bg-muted px-3 py-3 text-sm">
      <h3 className="text-sm font-semibold text-text-primary">{ASSIGN_COPY.whatChanges}</h3>
      {state.status === "loading" ? (
        <div className="flex flex-col gap-2" aria-label={ASSIGN_COPY.previewing}>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : null}
      {state.status === "failed" ? <p className="text-text-secondary">{ASSIGN_COPY.previewFailed}</p> : null}
      {state.status === "ready" ? <PreviewLines preview={state.preview} groups={groups} /> : null}
    </section>
  );
}

function PreviewLines({ preview, groups }: { preview: MemberGroupPreview; groups: MemberGroup[] }) {
  const before = preview.current.tariff;
  const after = preview.would_be.tariff;
  const lines: string[] = [];
  if (before && after) {
    const afterGroup = groups.find((g) => g.id === after.rate_group_id)?.name ?? null;
    lines.push(rateChangeLine(before.top_up_credits_per_zar, after.top_up_credits_per_zar, afterGroup));
    lines.push(peakChangeLine(before.peak_priority, after.peak_priority, after.peak_withheld_by ?? []));
  }
  const sliceBefore = preview.current.slice_price_credits;
  const sliceAfter = preview.would_be.slice_price_credits;
  if (typeof sliceBefore === "number" && typeof sliceAfter === "number" && sliceBefore !== sliceAfter) {
    lines.push(`A slot costs ${sliceAfter} cr instead of ${sliceBefore}.`);
  }
  lines.push(...rulesChangeLines(preview.current, preview.would_be));
  const stranded = preview.would_be.empty_window_groups;
  return (
    <>
      <ul className="flex flex-col gap-1 text-text-secondary">
        {lines.length === 0 ? <li>{ASSIGN_COPY.nothingChanges}</li> : lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
      {stranded && stranded.length > 0 ? (
        <p className="font-medium text-warning-strong">
          {`${stranded.join(" and ")} have no times in common, so they could book nothing on this day.`}
        </p>
      ) : null}
    </>
  );
}
