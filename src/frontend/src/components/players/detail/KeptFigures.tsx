/**
 * R11 (FA11's ask) — the booking's heading broke "Sun 4 / Oct" at 320 px / 200 %: a figure split
 * from its unit. Each "digit + word" pair is held on one line by a no-wrap span; the spaces stay
 * ordinary spaces, so the heading's accessible name (and the route announcer's) is unchanged —
 * a no-break space glued in the text itself would change the name an exact query and a reader get.
 */
export function KeptFigures({ text }: { text: string }) {
  const parts = text.split(/(\d+ \p{L}+)/u);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1
        ? <span key={i} className="whitespace-nowrap" data-kept-figure="">{part}</span>
        : part))}
    </>
  );
}
