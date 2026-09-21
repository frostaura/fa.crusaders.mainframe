import { cn } from "../lib/utils";
import { useClubUi, type ActionGlyphSet } from "../lib/clubUi";

/**
 * The marks a confirm, a decline and a refusal wear — drawn here, by hand, in this file.
 *
 * <p>
 * <b>Why not `lucide-react`, which is already a dependency.</b> Three reasons, in order of
 * how much they cost. The drawn-on outcome needs a known path length: the tick has to
 * <em>draw itself</em> over 180 ms rather than fade in, which means
 * <code>stroke-dasharray</code> on a path whose length the stylesheet knows. An imported icon's
 * geometry is whatever the library ships this week. Second, <code>src/types/lucide-react.d.ts</code>
 * is a hand-maintained ambient declaration with <b>no fall-through</b> — its own closing note
 * says so — so `ThumbsUp` and `ThumbsDown` would each need a line in it, and an unlisted icon
 * fails the type-check pointing at lucide-react, which exports it perfectly well. Third, this
 * repo already has the house pattern for a hand-drawn mark: `CourtMotif` in `pages/Home.tsx`.
 * </p>
 *
 * <p>
 * <b>`pathLength={24}` is the load-bearing attribute.</b> It tells the browser to treat every
 * path as 24 units long whatever its real geometry, so the single
 * <code>fb-draw</code> keyframe — 24 → 0 — draws a tick, a cross and a thumb identically, and
 * a later nudge to a curve cannot silently half-draw it.
 * </p>
 *
 * <p>
 * <b>Forced colours.</b> Stroked in <code>currentColor</code>, never a
 * <code>background-image</code> and never a mask: a Windows High Contrast palette throws away
 * author fills and keeps a stroke that inherits the text colour, so the glyph is one of the
 * three things (glyph, word, boundary) that survive the mode. `e2e/feedback-theme.spec.ts`
 * measures it rather than assuming it.
 * </p>
 *
 * <p>
 * <b>Always `aria-hidden`.</b> Every glyph this theme draws sits beside a word, and the word
 * is the accessible name. A glyph that announced itself would be the second announcement of
 * one fact — the defect `Toast.tsx:62-74` and `ConfirmButton.tsx:635-639` both record.
 * </p>
 */

/** What the mark MEANS, not what it looks like. The club's setting decides the shape. */
export type ActionGlyphKind = "affirm" | "decline" | "failure";

type GlyphProps = {
  /** px. 16 beside a 14 px label is the pairing every call site uses. */
  size?: number;
  className?: string;
  /** Draw the stroke on over `--fb-in` instead of simply being there. */
  draw?: boolean;
};

/**
 * The one set of attributes every glyph below shares.
 *
 * <p>
 * `data-glyph` names the MARK, not the meaning: two clubs on opposite settings draw a
 * different shape for the same `affirm`, and the question a browser check has to be able to
 * ask is which shape is on the glass. Without it, "is a thumb actually there" is a pixel
 * comparison — which passes for a ✓ shipped where a thumb was ordered, and fails for a 1 px
 * nudge to a curve. One attribute, and `e2e/action-feedback.spec.ts` asks the real question.
 * </p>
 */
function glyphFrame(name: string, size: number, className?: string) {
  return {
    "data-glyph": name,
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.25,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    // Both, and they are not the same thing. `aria-hidden` keeps it out of the accessibility
    // tree; `focusable="false"` keeps it out of the TAB ORDER, which older Edge and IE put
    // every inline <svg> into regardless. The product still has members on old machines.
    "aria-hidden": true,
    focusable: "false" as const,
    className: cn("shrink-0", className),
  };
}

/**
 * The draw. `motion-reduce:animate-none` at the use site, not only in `index.css`.
 *
 * There is no global rule that stands Tailwind's `animation` shorthand down — the
 * reduced-motion block in `index.css` covers the affordance layer's transitions and a named
 * list of `[data-fb]` animations, and a class is what covers the rest. `ConfirmButton`'s
 * spinner records the same lesson at its own use site.
 */
const DRAW_CLASS = "animate-fb-draw motion-reduce:animate-none";

/** Dashed to its own declared length, so the keyframe's `24 → 0` is exact. */
function drawAttrs(draw: boolean | undefined) {
  return {
    pathLength: 24,
    strokeDasharray: draw ? 24 : undefined,
    className: draw ? DRAW_CLASS : undefined,
  };
}

export function CheckGlyph({ size = 16, className, draw }: GlyphProps) {
  return (
    <svg {...glyphFrame("check", size, className)}>
      <path d="M4.5 12.5 L9.75 18 L19.5 6.5" {...drawAttrs(draw)} />
    </svg>
  );
}

export function CrossGlyph({ size = 16, className, draw }: GlyphProps) {
  return (
    <svg {...glyphFrame("cross", size, className)}>
      {/* Two strokes rather than one polyline: a cross drawn as a single path has to travel
          back across itself, and the draw animation shows it doing so. */}
      <path d="M6.5 6.5 L17.5 17.5" {...drawAttrs(draw)} />
      <path d="M17.5 6.5 L6.5 17.5" {...drawAttrs(draw)} />
    </svg>
  );
}

/**
 * The thumb, hand-drawn: a cuff, and one continuous outline for the hand.
 *
 * <p>
 * One path for the hand, deliberately, so the draw reads as a single gesture being made
 * rather than as three strokes appearing. The cuff is separate because it is a separate
 * object; it draws with it.
 * </p>
 */
function ThumbShape({ draw }: { draw?: boolean }) {
  return (
    <>
      <path d="M3.6 10.6 h4.6 v10.2 H3.6 a1.1 1.1 0 0 1 -1.1 -1.1 v-8 a1.1 1.1 0 0 1 1.1 -1.1 z" {...drawAttrs(draw)} />
      <path
        d="M8.2 10.6 L12.4 3.4 a1.9 1.9 0 0 1 3.45 1.55 L14.7 9.7 h4.7 a2 2 0 0 1 1.95 2.45 l-1.5 6.7 A2 2 0 0 1 17.9 20.8 H8.2 z"
        {...drawAttrs(draw)}
      />
    </>
  );
}

export function ThumbsUpGlyph({ size = 16, className, draw }: GlyphProps) {
  return (
    <svg {...glyphFrame("thumbs-up", size, className)}>
      <ThumbShape draw={draw} />
    </svg>
  );
}

/**
 * Thumbs down is thumbs up turned over, and it is a `rotate` rather than a second drawing.
 *
 * Two hand-drawn paths would drift the moment either was nudged, and a pair whose halves do
 * not match is a pair that reads as two different icons. 180° about the centre of the box
 * keeps them mirror images by construction.
 */
export function ThumbsDownGlyph({ size = 16, className, draw }: GlyphProps) {
  return (
    <svg {...glyphFrame("thumbs-down", size, className)}>
      <g transform="rotate(180 12 12)">
        <ThumbShape draw={draw} />
      </g>
    </svg>
  );
}

/**
 * A refusal. The same in both sets: a failure is not a gesture and there is no thumb for it.
 *
 * The dot is drawn as a zero-length stroke with a round cap, which is a round dot at any
 * stroke width and survives forced colours; a filled `<circle>` would not.
 */
export function AlertGlyph({ size = 16, className, draw }: GlyphProps) {
  return (
    <svg {...glyphFrame("alert", size, className)}>
      <circle cx="12" cy="12" r="9.25" {...drawAttrs(draw)} />
      <path d="M12 7.25 v5.25" {...drawAttrs(draw)} />
      <path d="M12 16.4 v0.01" {...drawAttrs(draw)} />
    </svg>
  );
}

/** The component for a meaning, in a named set. Exported for tests and for `useActionFeedback`. */
export function glyphFor(kind: ActionGlyphKind, set: ActionGlyphSet) {
  if (kind === "failure") return AlertGlyph;
  if (set === "thumbs") return kind === "affirm" ? ThumbsUpGlyph : ThumbsDownGlyph;
  return kind === "affirm" ? CheckGlyph : CrossGlyph;
}

/**
 * The glyph for a meaning, in whichever set the club has chosen.
 *
 * <p>
 * `set` is an override for a test or a preview; nothing in the product passes it, because the
 * point of the setting is that no call site decides.
 * </p>
 *
 * <p>
 * <b>A switch, not `const Glyph = glyphFor(…); <Glyph/>`.</b> The capitalised-variable form
 * reads better and `react-hooks`'s "Cannot create components during render" rule refuses it —
 * rightly in general, since a component identity that changes between renders remounts its
 * whole subtree and loses its state. It would be safe here (the four are module constants) but
 * a rule that cannot tell the difference is a rule worth writing around rather than silencing,
 * and the switch is what the next reader has to check anyway.
 * </p>
 */
export function ActionGlyph({ kind, set, ...rest }: GlyphProps & { kind: ActionGlyphKind; set?: ActionGlyphSet }) {
  const club = useClubUi();
  const chosen = set ?? club.actionGlyphs;
  if (kind === "failure") return <AlertGlyph {...rest} />;
  if (chosen === "thumbs") {
    return kind === "affirm" ? <ThumbsUpGlyph {...rest} /> : <ThumbsDownGlyph {...rest} />;
  }
  return kind === "affirm" ? <CheckGlyph {...rest} /> : <CrossGlyph {...rest} />;
}
