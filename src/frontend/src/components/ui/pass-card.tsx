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

/** The card's width (D7: viewport pixels) and the margin that centres it on a narrower column. */
const PASS_WIDTH = "w-[min(calc(100vw-32px),360px)] ml-[calc((100%-min(calc(100vw-32px),360px))/2)]";

const BAND_MASK = notchMask("bottom");
const BODY_MASK = notchMask("top");

/*
  The band's and the body's padding are PIXELS, like every other length above the symbol: a
  reader who turns their text up gets bigger words, not a pass whose QR has been pushed below
  the fold by padding that grew with the font (My Code's D7 / D8).
*/
/*
  R9 L9-4 — the band is a grid whose AREAS step down when the TEXT is large for the band (a rem
  query on the band's own box: 14rem is 224px at normal text, 448px at 200 %). Side by side, the
  crest and avatar flank the overline and both names; stepped down, "MEMBER" and the avatar share
  the first row and the names take the band's whole width under them. At 320 / 200 % the names
  truncated to "C…" / "Le…" and the overline ran over the avatar. Names wrap at their spaces,
  never cut; only a word longer than the whole band may break. Stepped down, the crest (decoration:
  the app bar carries the club's mark) is not drawn — beside an 80px avatar it left "MEMBER" 88px —
  and the overline shares the avatar's row rather than taking its own, so the stepped band costs
  one row, not two: the QR stays inside one screen of `<main>` at 320 × 568 with a 32px root.
*/
/*
  R14 L14-3 — between the two, from 14rem to 21rem of band (a 360px band at 17–25px text, any band
  under 336px at normal text), the crest and the avatar flank only the overline and the club; the
  member's name takes the band's whole width under them. Flanked, the name had 320px less 6.5rem —
  169px at 150 % — and a long single-word surname broke mid-word ("Wolfeschlegelste/in"); Chromium's
  `hyphens: auto` never splits a Capitalised word, so a line of its own is the only cure.
*/
const BAND_AREAS = [
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3",
  "[grid-template-areas:'crest_over_avatar'_'crest_club_avatar'_'crest_member_avatar']",
  "[@container_pass-band_(min-width:14.01rem)_and_(max-width:21rem)]:[grid-template-areas:'crest_over_avatar'_'crest_club_avatar'_'member_member_member']",
  "[@container_pass-band_(min-width:14.01rem)_and_(max-width:21rem)]:gap-y-1",
  "[@container_pass-band_(max-width:14rem)]:[grid-template-areas:'over_over_avatar'_'club_club_club'_'member_member_member']",
  "[@container_pass-band_(max-width:14rem)]:gap-y-1",
].join(" ");

function Band({ crest, overline, clubName, memberName, avatar }: Pick<PassCardProps, "crest" | "overline" | "clubName" | "memberName" | "avatar">) {
  return (
    <div data-pass-band="" className={cn(BAND_AREAS, "bg-brand-strong px-[20px] pb-[24px] pt-[20px] text-brand-ink")} style={BAND_MASK}>
      {crest ? <div className="shrink-0 [grid-area:crest] [@container_pass-band_(max-width:14rem)]:hidden">{crest}</div> : null}
      <p className="min-w-0 self-end text-xs font-semibold uppercase tracking-overline [grid-area:over] [@container_pass-band_(max-width:14rem)]:self-center">{overline}</p>
      <p className="min-w-0 break-words font-display text-lg font-bold [font-stretch:108%] [grid-area:club]">{clubName}</p>
      {memberName ? <p className="min-w-0 self-start break-words text-sm font-medium [grid-area:member]">{memberName}</p> : null}
      {avatar ? <div className="shrink-0 justify-self-end [grid-area:avatar]">{avatar}</div> : null}
    </div>
  );
}

export function PassCard(props: PassCardProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const {
    clubName, crest, overline = "MEMBER", memberName, avatar, qr, code, meta, footer, label, className,
  } = props;
  /*
    R10 L10-3 — the card is as wide as before (D7: pixels and the viewport, never the root font, so
    the QR is the same size at any text size), and it is centred on its COLUMN by a margin of half
    the difference, which goes negative when the column is narrower. It was `mx-auto`, and an auto
    margin never goes below zero: at 200 % text the page gutter is 32px, the column 32px narrower
    than the card, and the card hung off the column's right side to the screen's edge — off-centre,
    its right corners and shadow cut. Now it reaches 16px into each gutter, symmetrically.
  */
  return (
    <article
      aria-label={label}
      data-pass-card=""
      className={cn(PASS_WIDTH, "flex flex-col rounded-2xl shadow-lg", className)}
    >
      <div className="overflow-hidden rounded-t-2xl [container:pass-band/inline-size]">
        <Band crest={crest} overline={overline} clubName={clubName} memberName={memberName} avatar={avatar} />
      </div>
      <div className="relative overflow-hidden rounded-b-2xl bg-bg-raised" style={BODY_MASK}>
        <div aria-hidden="true" data-perforation="" className="absolute inset-x-4 top-0 border-t-2 border-dashed border-border" />
        <div data-pass-body="" className="flex flex-col items-center gap-4 px-[20px] pb-5 pt-[24px]">
          {/*
            R17 L17-4 — the plate is white in BOTH themes, so a ring drawn on it is pinned to the
            brand navy (#00498D in both): the dark theme's accent (navy 300) measured 2.02:1 on it.
            The panel takes the body's width, capped, and centres whatever QR it is given — so a
            caller's `w-full` symbol is sized by the CARD (whose width is pixels, see above) and
            never by the root font. Every length between the card's edge and the symbol — the
            body's side padding, the panel's padding, the cap — is a PIXEL for the same reason
            (My Code's D7): in rem, a reader who turned their text up got a SMALLER symbol, and a
            QR sized in rem outright grew past a 320px phone.
          */}
          <div
            data-qr-panel=""
            className="flex w-full max-w-[304px] justify-center rounded-xl p-[12px] forced-color-adjust-none [&_:focus-visible]:outline-brand-strong"
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
