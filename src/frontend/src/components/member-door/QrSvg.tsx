import { useMemo } from "react";
import { encodeQr, qrPath } from "../../lib/qr";

/**
 * The symbol itself — a QR for `value`, black on white whatever the theme is doing.
 *
 * <p>
 * <b>Black on white, from tokens' reach.</b> A scanner in a dark doorway wants contrast,
 * and a dark-mode palette is light it does not get back. Nothing here reads a token.
 * </p>
 *
 * <p>
 * <b>Why it is its own file.</b> It was fifteen lines inside `pages/MyCode.tsx`, and the
 * complexity gate had been failing on it since this branch's first commit — for a reason
 * that was nothing to do with the component. `lizard`'s TypeScript reader loses the end of
 * a function that returns multi-line JSX: it read this one as running to line 400,
 * swallowing six functions and every doc comment between them, and reported 247 lines
 * against a limit of 200. The numbers therefore measured how much prose happened to sit
 * BELOW it, so any comment added anywhere in that stretch could turn the gate red on a
 * component nobody had touched — and shortening the component could not help.
 * </p>
 *
 * <p>
 * A whitelist entry would have frozen that, which is what `whitelizard.txt` is for and is
 * the wrong tool here: the entry would exempt a function whose real numbers are CCN 1 and
 * twenty lines, and it would go on hiding whatever the parser swallowed next. Moving the
 * component to the file it should always have been in leaves the artefact with nothing to
 * swallow, and MyCode.tsx is measured on its own code. It was `export`ed from a page and
 * imported by nothing, which is what a component in the wrong place looks like.
 * </p>
 */

/** How many modules of white surround the symbol. Four is the QR specification's minimum. */
const QUIET_ZONE = 4;

export function QrSvg({ value, className }: { value: string; className?: string }) {
  const matrix = useMemo(() => encodeQr(value), [value]);
  const extent = matrix.size + QUIET_ZONE * 2;
  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={`QR code ${value}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={qrPath(matrix, QUIET_ZONE)} fill="#000000" />
    </svg>
  );
}
