import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Interactable } from "@/components/ui/interactable";
import { Check, Lock } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { Demo, ThemePair } from "./parts";

/**
 * A miniature booking grid showing every slot state from `components.slot` (design-system.md,
 * "Slot-state component tokens"), plus the selected and on-court variants and a fixed tin now-line.
 * Row gap 4px, column gap 6px, cells 48px with radius md; selection is an INSET ring so neighbours
 * never touch. Actionable cells are buttons carrying the cell watermark; the rest are plain boxes,
 * and the missing watermark is itself the cue.
 */
type CellKind =
  | "available" | "selected" | "mine" | "on-court" | "mine-past" | "booked"
  | "past" | "hold" | "closed" | "restricted" | "idle";

const KIND_CLASS: Record<CellKind, string> = {
  available: "bg-slot-available-fill text-slot-available-ink",
  selected: "bg-slot-available-fill pl-7 text-slot-available-ink ring-2 ring-inset ring-accent-strong",
  mine: "bg-slot-mine-fill text-slot-mine-ink",
  "on-court": "bg-slot-mine-fill text-slot-mine-ink",
  "mine-past": "border-border bg-slot-mine-past-fill text-slot-mine-past-ink",
  booked: "bg-slot-booked-fill text-slot-booked-ink",
  past: "text-slot-past-ink",
  hold: "bg-slot-hold-fill bg-stripes text-slot-hold-ink",
  closed: "border-dashed border-border text-slot-closed-ink",
  restricted: "border-dashed border-warning-strong bg-slot-restricted-fill text-slot-restricted-ink",
  idle: "border-dashed border-border bg-slot-idle-fill/40 text-slot-idle-ink",
};

const ACTIONABLE: ReadonlySet<CellKind> = new Set(["available", "selected", "mine", "on-court", "booked"]);

const CELL = "no-lift relative flex h-12 min-w-0 items-center gap-1.5 rounded-md border border-transparent px-2 text-left text-xs font-semibold leading-tight";

type Slot = { kind: CellKind; court: number; time: string };

const TIMES = ["17:00", "17:30", "18:00", "18:30", "19:00"];

/** Rows of three courts. Court 3 is out of use until 18:30. */
const LAYOUT: readonly CellKind[][] = [
  ["past", "mine-past", "idle"],
  ["past", "on-court", "idle"],
  ["available", "booked", "idle"],
  ["selected", "mine", "hold"],
  ["restricted", "available", "closed"],
];

function CellText({ kind }: { kind: CellKind }) {
  switch (kind) {
    case "available": return <span>Book</span>;
    case "selected": return <span>Selected</span>;
    case "mine": return <span>Your court</span>;
    case "on-court": return <span className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-success-strong motion-reduce:animate-none" />On court</span>;
    case "mine-past": return <span>Played</span>;
    case "booked": return <span className="flex min-w-0 items-center gap-1.5"><Avatar size={24} aria-hidden="true"><AvatarFallback name="Sam Smith" /></Avatar><span className="truncate">Sam</span></span>;
    case "past": return <span>—</span>;
    case "hold": return <span className="flex flex-col">League<span className="font-medium">Club hold</span></span>;
    case "closed": return <span>Closed</span>;
    case "restricted": return <span className="flex items-center gap-1"><Lock size={14} weight="bold" aria-hidden="true" />Peak</span>;
    default: return <span>Not in use</span>;
  }
}

const SPOKEN: Record<CellKind, string> = {
  available: "available, book",
  selected: "selected",
  mine: "your court",
  "on-court": "your court, on court now",
  "mine-past": "played",
  booked: "booked by Sam Smith",
  past: "past",
  hold: "club hold for League",
  closed: "closed",
  restricted: "peak hours, restricted",
  idle: "court not in use",
};

function Cell({ slot }: { slot: Slot }) {
  const name = `Court ${slot.court}, ${slot.time}, ${SPOKEN[slot.kind]}`;
  const classes = cn(CELL, KIND_CLASS[slot.kind]);
  if (!ACTIONABLE.has(slot.kind)) {
    return <div role="img" aria-label={name} data-slot-kind={slot.kind} className={classes}><CellText kind={slot.kind} /></div>;
  }
  const selected = slot.kind === "selected";
  return (
    <Interactable asChild surface="cell" watermark>
      <button
        type="button"
        aria-label={name}
        aria-pressed={selected || undefined}
        data-state={selected ? "on" : undefined}
        data-slot-kind={slot.kind}
        className={classes}
      >
        {selected ? (
          <span aria-hidden="true" className="absolute left-1.5 top-1.5 flex size-4 items-center justify-center rounded-sm bg-primary text-primary-ink">
            <Check size={12} weight="bold" />
          </span>
        ) : null}
        <CellText kind={slot.kind} />
      </button>
    </Interactable>
  );
}

function NowLine() {
  // 17:55: header (2rem) + gap + the 17:00 row (3rem) + gap, then 40px of the 48px 17:30 row —
  // below that row's centred label, so the line never crosses text. In rem so a larger root
  // font scales it with the rows. The caption sits ABOVE the line, clear of the 17:30 time.
  return (
    <div aria-hidden="true" data-now-line="" className="pointer-events-none absolute inset-x-0 z-raised" style={{ top: "8rem" }}>
      <div className="h-0.5 w-full -translate-y-1/2 bg-brand-tin" />
      <span className="absolute left-0 top-0 size-2 -translate-y-1/2 rounded-full bg-brand-tin" />
      <span className="absolute bottom-0.5 left-3 text-xs font-semibold leading-none text-brand-tin">Now</span>
    </div>
  );
}

function MiniGrid() {
  return (
    <div className="relative grid min-w-max grid-cols-[48px_repeat(3,minmax(104px,1fr))] gap-x-1.5 gap-y-1">
      <span aria-hidden="true" className="h-8" />
      {[1, 2, 3].map((court) => (
        <span key={court} className="flex h-8 items-end pb-1 text-xs font-semibold text-text-secondary">{`Court ${court}`}</span>
      ))}
      {LAYOUT.map((row, r) => [
        <span key={`t${r}`} className="h-12 text-xs tabular-nums text-text-muted">{TIMES[r]}</span>,
        ...row.map((kind, c) => <Cell key={`${r}-${c}`} slot={{ kind, court: c + 1, time: TIMES[r] }} />),
      ])}
      <NowLine />
    </div>
  );
}

export function GridSection() {
  return (
    <Demo
      title="Slot states"
      note="Every state in components.slot, plus selected and on court. The tin line is now, fixed at 17:55 for the demo. Only actionable cells carry the watermark."
    >
      <ThemePair>{() => <MiniGrid />}</ThemePair>
    </Demo>
  );
}
