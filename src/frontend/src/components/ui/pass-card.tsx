import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The member's pass (design-system.md, Patterns → Pass card): a boarding-pass layout shell for My
 * Code. It knows nothing about codes — the page passes the QR, the grouped code, the countdown
 * and the offline badge into its slots.
 *
 * <p>
 * Anatomy, top to bottom: a navy brand band (crest · "MEMBER" · club name · member · avatar) that
 * stays navy in the dark theme; a perforation — two semicircular notches cut from the card's
 * edges by a radial-gradient mask on each half, and a dashed rule between them; the body on the
 * raised surface with the QR panel and the code; an optional footer.
 * </p>
 *
 * <p>
 * <b>The QR panel is ALWAYS white</b>, in both themes and under forced colours
 * (`forced-color-adjust: none`), because a scanner wants dark modules on a light field — a QR in
 * the club's dark palette fails a marginal read in a dark doorway. {@link QR_PAPER} is the one
 * literal colour in `components/ui/`; the token hex ban exempts this file by name for that reason
 * and no other. No watermark, ever: the pass is on the spec's "Never" list.
 * </p>
 */
export type PassCardProps = {
  /** The club's name, in the display face. */
  clubName: ReactNode;
  /** The crest, ~40px, on the navy band. */
  crest?: ReactNode;
  /** The overline above the club name. */
  overline?: ReactNode;
  /** The member's name, under the club name. */
  memberName?: ReactNode;
  /** The member's avatar, on the band's right. */
  avatar?: ReactNode;
  /** The QR itself (dark modules; the panel supplies the white field and padding). */
  qr: ReactNode;
  /** The typed code, in JetBrains Mono — "482 913". */
  code?: ReactNode;
  /** Beside/under the code: the CountdownRing and its sentence, an offline badge. */
  meta?: ReactNode;
  footer?: ReactNode;
  /** The card's accessible name. */
  label?: string;
  className?: string;
};

/** Paper white for the QR panel — see the file header. Not a theme colour, a scanner requirement. */
const QR_PAPER = "#FFFFFF";

/** The perforation notch radius, px. */
const NOTCH = 10;

/** Two half-width mask layers, each cutting a notch at one outer corner on the given edge. */
function notchMask(edge: "top" | "bottom"): CSSProperties {
  const y = edge === "top" ? "0" : "100%";
  const cut = (x: string) =>
    `radial-gradient(circle at ${x} ${y}, transparent ${NOTCH}px, black ${NOTCH + 0.5}px)`;
  const layers = `${cut("0")}, ${cut("100%")}`;
  return {
    maskImage: layers,
    WebkitMaskImage: layers,
    maskSize: "51% 100%",
    WebkitMaskSize: "51% 100%",
    maskPosition: "left, right",
    WebkitMaskPosition: "left, right",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
  };
}

const BAND_MASK = notchMask("bottom");
const BODY_MASK = notchMask("top");

function Band({ crest, overline, clubName, memberName, avatar }: Pick<PassCardProps, "crest" | "overline" | "clubName" | "memberName" | "avatar">) {
  return (
    <div data-pass-band="" className="flex items-center gap-3 bg-brand-strong px-5 pb-6 pt-5 text-brand-ink" style={BAND_MASK}>
      {crest ? <div className="shrink-0">{crest}</div> : null}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-overline">{overline}</p>
        <p className="truncate font-display text-lg font-bold [font-stretch:108%]">{clubName}</p>
        {memberName ? <p className="truncate text-sm font-medium">{memberName}</p> : null}
      </div>
      {avatar ? <div className="shrink-0">{avatar}</div> : null}
    </div>
  );
}

export function PassCard(props: PassCardProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const {
    clubName, crest, overline = "MEMBER", memberName, avatar, qr, code, meta, footer, label, className,
  } = props;
  return (
    <article
      aria-label={label}
      data-pass-card=""
      className={cn("mx-auto flex w-[min(calc(100vw-32px),360px)] flex-col rounded-2xl shadow-lg", className)}
    >
      <div className="overflow-hidden rounded-t-2xl">
        <Band crest={crest} overline={overline} clubName={clubName} memberName={memberName} avatar={avatar} />
      </div>
      <div className="relative overflow-hidden rounded-b-2xl bg-bg-raised" style={BODY_MASK}>
        <div aria-hidden="true" data-perforation="" className="absolute inset-x-4 top-0 border-t-2 border-dashed border-border" />
        <div className="flex flex-col items-center gap-4 px-5 pb-5 pt-6">
          <div
            data-qr-panel=""
            className="rounded-xl p-3 forced-color-adjust-none"
            style={{ backgroundColor: QR_PAPER }}
          >
            {qr}
          </div>
          {code ? <div data-pass-code="" className="font-mono text-2xl font-semibold tracking-code text-text-primary tabular-nums">{code}</div> : null}
          {meta ? <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-text-secondary">{meta}</div> : null}
        </div>
        {footer ? <div className="border-t border-border px-5 py-3 text-sm text-text-secondary">{footer}</div> : null}
      </div>
    </article>
  );
}
