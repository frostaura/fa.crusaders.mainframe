import * as React from "react";
import { CaretDown, Check } from "@/components/ui/icons";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
} from "@/components/ui/command";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { fieldSurface } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsSmUp } from "@/components/ui/use-media-query";
import { Minutes } from "@/components/Minutes";
import { cn } from "@/lib/utils";

/**
 * Pick one member from a searchable list (design-system.md: member-combobox).
 *
 * <p>
 * cmdk in a Popover from `sm` up; a full-height Sheet on a phone, where a popover under a thumb
 * and an on-screen keyboard leaves no room for the list. The trigger is a labelled
 * `role="combobox"` button showing the chosen member (avatar, name, optional balance); the panel's
 * search box filters by name and subtitle as the person types, arrow keys move, Enter picks, and
 * Escape closes with focus returned to the trigger.
 * </p>
 *
 * <p>
 * Photo + name only by default — the booking grid's privacy rule (CLAUDE.md, Invariants) applies
 * to anything a member can see. `subtitle` and `balance` are for admin surfaces.
 * </p>
 */

export type ComboboxMember = {
  id: string;
  name: string;
  photoUrl?: string | null;
  /** Whole minutes. Shown right-aligned; negative reads in the danger ink. */
  balance?: number | null;
  subtitle?: string | null;
};

export type MemberComboboxProps = {
  members: readonly ComboboxMember[];
  value: string | null | undefined;
  onChange: (id: string) => void;
  label: string;
  placeholder?: string;
  loading?: boolean;
  error?: string | null;
  emptyText?: string;
  disabled?: boolean;
  /** Visually hide the label (it still names the combobox). */
  hideLabel?: boolean;
  className?: string;
};

/*
  R10 (lane FA10) — the row at 200 % text. At 320 / 200 % the trigger and every list row had
  ~90px for the name beside a 64px avatar and a no-shrink balance, so names truncated to nothing
  and the balance ran under the caret. The row is a query container: when the TEXT is large for
  the row (under 12rem — 192px at 100 %, 384px at 200 %) the avatar, which is decoration (the
  name is what is read), is not drawn. Names wrap at their spaces, never cut; the balance sits
  beside the name and wraps UNDER it, right-aligned, when the two do not fit on one line.
*/
const ROW_STEPS_DOWN = "[@container_member-row_(max-width:12rem)]:hidden";

/** Decorative: the name beside it is what is read, so the avatar is hidden from assistive tech. */
function MemberAvatar({ member }: { member: ComboboxMember }) {
  return (
    <Avatar size={32} aria-hidden="true" className={ROW_STEPS_DOWN}>
      {member.photoUrl ? <AvatarImage src={member.photoUrl} alt="" /> : null}
      <AvatarFallback name={member.name} />
    </Avatar>
  );
}

function Balance({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return null;
  return (
    <Minutes value={value} className={cn("ml-auto whitespace-nowrap text-xs", value < 0 ? "text-danger-strong" : "text-text-secondary")} />
  );
}

/** Avatar, name (and subtitle), balance — the same row in the trigger and in the list. */
function MemberRow({ member }: { member: ComboboxMember }) {
  return (
    <span data-member-row="" className="flex min-w-0 flex-1 [container:member-row/inline-size]">
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <MemberAvatar member={member} />
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
          <span className="flex min-w-0 flex-col">
            <span className="break-words text-sm font-medium text-text-primary">{member.name}</span>
            {member.subtitle ? <span className="break-words text-xs text-text-muted">{member.subtitle}</span> : null}
          </span>
          <Balance value={member.balance} />
        </span>
      </span>
    </span>
  );
}

type TriggerProps = React.ComponentProps<"button"> & {
  selected: ComboboxMember | undefined;
  placeholder: string;
  valueId: string;
  invalid: boolean;
};

function ComboTrigger({ selected, placeholder, valueId, invalid, className, ...props }: TriggerProps) {
  return (
    <button
      type="button"
      role="combobox"
      aria-haspopup="dialog"
      aria-invalid={invalid || undefined}
      data-slot="member-combobox-trigger"
      className={cn(fieldSurface, "flex min-h-touch items-center gap-3 px-3 py-1.5 text-left hover:bg-bg-muted", className)}
      {...props}
    >
      <span id={valueId} className="flex min-w-0 flex-1 items-center gap-3">
        {selected ? <MemberRow member={selected} /> : <span className="text-sm text-text-muted">{placeholder}</span>}
      </span>
      <CaretDown size="1rem" aria-hidden="true" className="shrink-0 text-text-secondary" />
    </button>
  );
}

function LoadingRows() {
  return (
    <CommandLoading label="Loading members">
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden="true" className="flex min-h-touch items-center gap-3 px-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-32 rounded-sm" />
        </div>
      ))}
    </CommandLoading>
  );
}

type OptionsProps = {
  members: readonly ComboboxMember[];
  value: string | null | undefined;
  loading: boolean;
  emptyText: string;
  onPick: (id: string) => void;
  className?: string;
};

/**
 * Matches on the name and subtitle only — never the id, which is the item's value — as a
 * case-insensitive substring of any word order the person types ("smi sam" finds Sam Smith).
 */
function matchByName(_value: string, search: string, keywords?: string[]): number {
  const haystack = (keywords ?? []).join(" ").toLocaleLowerCase();
  const words = search.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return words.every((word) => haystack.includes(word)) ? 1 : 0;
}

/** The searchable list. Items are keyed by id; `matchByName` filters on what a person can see. */
function MemberOptions({ members, value, loading, emptyText, onPick, className }: OptionsProps) {
  return (
    <Command label="Search members" filter={matchByName} className={className}>
      <CommandInput placeholder="Search by name" />
      <CommandList className="flex-1">
        {loading ? <LoadingRows /> : <CommandEmpty>{emptyText}</CommandEmpty>}
        {members.map((member) => (
          <CommandItem
            key={member.id}
            value={member.id}
            keywords={[member.name, member.subtitle ?? ""]}
            onSelect={() => onPick(member.id)}
          >
            <MemberRow member={member} />
            <Check
              size="1rem"
              aria-hidden="true"
              className={cn("shrink-0 text-accent-strong", member.id === value ? "opacity-100" : "opacity-0")}
            />
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

function FieldError({ id, error }: { id: string; error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p id={id} className="text-sm text-danger-strong">
      {error}
    </p>
  );
}

function MemberCombobox(props: MemberComboboxProps) {
  const {
    members,
    value,
    onChange,
    label,
    placeholder = "Choose a member",
    loading = false,
    error,
    emptyText = "No members match",
    disabled,
    hideLabel,
    className,
  } = props;
  const [open, setOpen] = React.useState(false);
  const wide = useIsSmUp();
  const base = React.useId();
  const ids = { label: `${base}-label`, value: `${base}-value`, error: `${base}-error` };
  const selected = members.find((m) => m.id === value);
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  const trigger = (
    <ComboTrigger
      selected={selected}
      placeholder={placeholder}
      valueId={ids.value}
      invalid={Boolean(error)}
      disabled={disabled}
      aria-labelledby={`${ids.label} ${ids.value}`}
      aria-describedby={error ? ids.error : undefined}
      onKeyDown={(e) => openOnArrow(e, setOpen)}
    />
  );
  const options = { members, value, loading, emptyText, onPick: pick };
  return (
    <div data-slot="member-combobox" className={cn("flex flex-col gap-1.5", className)}>
      <span id={ids.label} className={cn("text-sm font-medium text-text-primary", hideLabel && "sr-only")}>
        {label}
      </span>
      {wide ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-72 p-0">
            <MemberOptions {...options} />
          </PopoverContent>
        </Popover>
      ) : (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent size="full" guardTyped={false} aria-describedby={undefined}>
            <SheetHeader>
              <SheetTitle>{label}</SheetTitle>
            </SheetHeader>
            <MemberOptions {...options} className="min-h-0 flex-1 [&_[cmdk-list]]:max-h-none" />
          </SheetContent>
        </Sheet>
      )}
      <FieldError id={ids.error} error={error} />
    </div>
  );
}

/** ArrowDown/ArrowUp on the closed trigger opens it, as a native select does. */
function openOnArrow(event: React.KeyboardEvent, setOpen: (open: boolean) => void) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  setOpen(true);
}

export { MemberCombobox };
