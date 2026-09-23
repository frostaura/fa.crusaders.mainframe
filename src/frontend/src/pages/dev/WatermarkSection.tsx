import "./gallery.css";
import { Button } from "@/components/ui/button";
import { Interactable, type InteractableSurface } from "@/components/ui/interactable";
import { components } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { Demo, Specimen, ThemePair } from "./parts";

/**
 * The fingerprint watermark on each surface, in each of its six phases. Hover and press are
 * pinned with the gallery's own `data-demo-state` (see `gallery.css`) so they can be read side by
 * side; selected, busy and disabled use the real attributes the watermark stylesheet keys on, and
 * the glyph is absent in all three — its absence is the cue.
 */
type Phase = "rest" | "hover" | "press" | "selected" | "busy" | "disabled";

const PHASES: readonly Phase[] = ["rest", "hover", "press", "selected", "busy", "disabled"];

type HostAttributes = {
  "data-demo-state"?: "hover" | "press";
  "aria-pressed"?: boolean;
  "data-state"?: "on";
  "aria-busy"?: boolean;
  disabled?: boolean;
};

/** The attributes that put a host in `phase`. `selected` is a pressed toggle, as a chosen cell is. */
function phaseAttributes(phase: Phase): HostAttributes {
  if (phase === "hover" || phase === "press") return { "data-demo-state": phase };
  if (phase === "selected") return { "aria-pressed": true, "data-state": "on" };
  if (phase === "busy") return { "aria-busy": true };
  if (phase === "disabled") return { disabled: true };
  return {};
}

const HOST: Record<Exclude<InteractableSurface, "cta">, string> = {
  cell: "h-12 w-24 rounded-md bg-slot-available-fill px-2 text-left text-sm font-semibold text-slot-available-ink",
  card: "h-20 w-40 rounded-xl border-border bg-bg-surface p-3 text-left text-sm font-semibold text-text-primary shadow-xs",
  tile: "h-28 w-40 rounded-2xl border-border bg-bg-surface p-4 text-left text-base font-semibold text-text-primary shadow-xs",
};

const LABEL: Record<Exclude<InteractableSurface, "cta">, string> = {
  cell: "Book",
  card: "Sam Smith",
  tile: "Court 2",
};

function PlainHost({ surface, phase }: { surface: Exclude<InteractableSurface, "cta">; phase: Phase }) {
  return (
    <Interactable asChild surface={surface} watermark>
      <button
        type="button"
        className={cn("flex items-start border border-transparent", HOST[surface], "disabled:opacity-50")}
        {...phaseAttributes(phase)}
      >
        {LABEL[surface]}
      </button>
    </Interactable>
  );
}

/** The large primary CTA is the real Button, as a page would write it. Busy is its `pending`. */
function CtaHost({ phase }: { phase: Phase }) {
  const { "aria-busy": busy, ...attributes } = phaseAttributes(phase);
  return (
    <Interactable asChild surface="cta" watermark>
      <Button size="lg" pending={busy} {...attributes}>Book · 8 cr</Button>
    </Interactable>
  );
}

const SURFACES: readonly InteractableSurface[] = ["cell", "card", "tile", "cta"];

function SurfaceRow({ surface }: { surface: InteractableSurface }) {
  const geometry = components.watermarkGeometry[surface];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold text-text-primary">{`${surface} · ${geometry.size}px glyph`}</p>
      <div className="flex flex-wrap gap-3">
        {PHASES.map((phase) => (
          <Specimen key={phase} label={phase}>
            {surface === "cta" ? <CtaHost phase={phase} /> : <PlainHost surface={surface} phase={phase} />}
          </Specimen>
        ))}
      </div>
    </div>
  );
}

export function WatermarkSection() {
  return (
    <Demo
      title="Fingerprint watermark"
      note="Hover and press are pinned for display. Selected, busy and disabled hide the glyph. Forced colours and print hide it everywhere."
    >
      <ThemePair>
        {() => (
          <div className="flex flex-col gap-6">
            {SURFACES.map((surface) => <SurfaceRow key={surface} surface={surface} />)}
          </div>
        )}
      </ThemePair>
    </Demo>
  );
}
