import { keepFiguresWhole } from "@/components/ui/figure-text";

/**
 * R18 L18-1 — "18:00–18:45" is one figure: at 320 / 200 % it broke after the dash (a line may break
 * after an en dash). The day may wrap at its spaces; the time range never does, and the text the
 * reader hears is unchanged. Shared by the invites card and the invite page's game facts, so the two
 * cannot disagree: the page's facts broke "18:00– / 18:45" at 320 / 150 % on any date whose day is
 * two digits ("Mon 12 Oct" is one glyph wider than "Thu 8 Oct").
 */
export function WhenWhole({ when }: { when: string }) {
  const cut = when.lastIndexOf(", ");
  // R19 L19-3 — and the day's own figure stays with its month ("7 Oct").
  if (cut < 0) return <>{keepFiguresWhole(when)}</>;
  return <>{keepFiguresWhole(when.slice(0, cut + 2))}<span className="whitespace-nowrap">{when.slice(cut + 2)}</span></>;
}
