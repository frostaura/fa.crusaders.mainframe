import { useState } from "react";
import { Button } from "@/components/ui/button";
import { motion } from "@/lib/tokens";
import { cn } from "@/lib/utils";

/**
 * Every named duration and easing, played side by side. A bar fills with `scale-x` (a transform,
 * so nothing reflows) over its own duration. Under reduced motion every bar carries
 * `motion-reduce:transition-none` and simply jumps — which is the point of showing it.
 */
const DURATIONS: Record<keyof typeof motion.duration, string> = {
  press: "duration-press",
  fast: "duration-fast",
  base: "duration-base",
  enter: "duration-enter",
  in: "duration-in",
  hold: "duration-hold",
  settle: "duration-settle",
  shake: "duration-shake",
  count: "duration-count",
  breathe: "duration-breathe",
  sheet: "duration-sheet",
  tick: "duration-tick",
};

const EASINGS: Record<keyof typeof motion.easing, string> = {
  standard: "ease-standard",
  out: "ease-out",
  in: "ease-in",
};

function Bar({ label, timing, played }: { label: string; timing: string; played: boolean }) {
  return (
    <li className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3">
      <span className="font-mono text-xs text-text-secondary">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-bg-muted">
        <span
          aria-hidden="true"
          data-motion-bar=""
          className={cn(
            "block h-full origin-left rounded-full bg-accent-strong transition-transform motion-reduce:transition-none",
            timing,
            played ? "scale-x-100" : "scale-x-0",
          )}
        />
      </span>
    </li>
  );
}

export function MotionDemo() {
  const [played, setPlayed] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="outline" size="sm" onClick={() => setPlayed((p) => !p)}>
          {played ? "Reset" : "Play"}
        </Button>
      </div>
      <ul className="grid gap-2" aria-label="Durations, standard easing">
        {Object.entries(DURATIONS).map(([name, cls]) => (
          <Bar key={name} label={`${name} · ${motion.duration[name as keyof typeof DURATIONS]}`} timing={cn(cls, "ease-standard")} played={played} />
        ))}
      </ul>
      <ul className="grid gap-2" aria-label="Easings, at the count duration">
        {Object.entries(EASINGS).map(([name, cls]) => (
          <Bar key={name} label={`ease-${name}`} timing={cn(cls, "duration-count")} played={played} />
        ))}
      </ul>
    </div>
  );
}
