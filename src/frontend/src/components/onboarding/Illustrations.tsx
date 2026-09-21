/**
 * Three drawings of the real hardware, for item 16.
 *
 * <p>
 * <b>Stroke-first in `currentColor`, fills only as emphasis.</b> The house pattern is
 * `CourtMotif` on the home page — hand-drawn, `role="img"`, coloured with token classes, no
 * raster asset and no new dependency — and this follows it with one correction: `CourtMotif`
 * colours with `fill-accent-soft`, which `forced-colors: active` throws away and leaves an
 * outline. These survive that mode as line drawings, which is what a drawing of a physical
 * object needs to do.
 * </p>
 *
 * <p>
 * <b>No picture ever carries an instruction alone.</b> Each one sits beside the sentence that
 * says the same thing, so a member who cannot see it loses nothing. Each carries a `<title>`
 * as well as an `aria-label`, because the two are read by different things.
 * </p>
 */

const FRAME = "w-full max-w-[13rem] text-text-secondary";

/**
 * The one thing words are worst at: how far away to hold the phone.
 *
 * The distance is the whole reason this drawing exists. "About a hand's width" is the sentence
 * beside it, and the picture is what makes it a distance rather than a phrase.
 */
export function DoorScanner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 140"
      className={className ?? FRAME}
      role="img"
      aria-label="A phone held about a hand's width in front of the small scanner beside the club door, with the scanner's light showing green"
    >
      <title>Holding a phone in front of the door scanner</title>
      {/* The door, and its frame. */}
      <rect x="6" y="6" width="74" height="128" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="68" cy="72" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
      {/* The scanner box on the wall beside it. */}
      <rect x="92" y="48" width="26" height="44" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="98" y="56" width="14" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {/* Its light. The one filled mark in the drawing, and the only colour: green means the
          lock has released, which is the fact the member is waiting for. */}
      <circle cx="105" cy="80" r="4" className="fill-success-strong" />
      {/* The phone, held facing the scanner. */}
      <rect x="150" y="38" width="44" height="66" rx="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="158" y="50" width="28" height="28" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {/* A suggestion of the QR, at three strokes rather than a real symbol. */}
      <path d="M163 55h6v6h-6zM175 55h6v6h-6zM163 67h6v6h-6zM175 67h4" stroke="currentColor" strokeWidth="1.5" fill="none" />
      {/* The gap, measured. The arrow IS the instruction. */}
      <path d="M124 70h20m0 0-5-4m5 4-5 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Carl's box: the screen, the scanner window, and the two rows of buttons.
 *
 * The rows are drawn as four and four because that is what is on the wall — four green court
 * buttons and four black duration buttons, and no OK, Cancel or Back. Everything the guide
 * says about pressing follows from that.
 */
export function CourtBox({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 150"
      className={className ?? FRAME}
      role="img"
      aria-label="The court box on the wall: a small screen reading Scan your code, a scanner window, then a row of four court buttons above a row of four time buttons"
    >
      <title>The court box, with its screen and its two rows of buttons</title>
      <rect x="8" y="6" width="184" height="138" rx="8" fill="none" stroke="currentColor" strokeWidth="2" />
      {/* The screen, with its resting message. Drawn as two text lines rather than lettered:
          a 200-unit drawing cannot render sixteen legible characters, and an illegible
          caption reads as a rendering fault. The sentence beside the picture says the words. */}
      <rect x="20" y="18" width="120" height="44" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M28 32h74M28 44h50" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      {/* The scanner window. */}
      <rect x="150" y="18" width="30" height="44" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M157 32h16M157 40h16M157 48h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* Four court buttons. Filled, because they are the green row and the guide names them. */}
      {[0, 1, 2, 3].map((i) => (
        <circle key={`court-${i}`} cx={36 + i * 43} cy={90} r={12} className="fill-success-soft stroke-current" strokeWidth="2" />
      ))}
      {/* Four time buttons, outlined — the black row. */}
      {[0, 1, 2, 3].map((i) => (
        <circle key={`time-${i}`} cx={36 + i * 43} cy={124} r={12} fill="none" stroke="currentColor" strokeWidth="2" />
      ))}
    </svg>
  );
}

/** Four courts, one lit, with the box counting the minutes down. */
export function CourtLights({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 120"
      className={className ?? FRAME}
      role="img"
      aria-label="Four courts side by side with one lit, and the box screen counting down the minutes left on it"
    >
      <title>One court lit, with the time left on the box screen</title>
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={10 + i * 46}
          y={10}
          width={38}
          height={58}
          rx={3}
          className={i === 1 ? "fill-warning-soft stroke-current" : "stroke-current"}
          fill={i === 1 ? undefined : "none"}
          strokeWidth="2"
        />
      ))}
      {/* The lit one's lamp. */}
      <circle cx={75} cy={30} r="6" className="fill-warning-strong" />
      {/* The box screen underneath, showing a count rather than a word. */}
      <rect x="52" y="84" width="96" height="28" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M62 98h30M104 98h34" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** The three, by the name the copy module uses. */
export const ILLUSTRATIONS = { door: DoorScanner, box: CourtBox, lights: CourtLights } as const;
