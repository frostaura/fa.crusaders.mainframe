/**
 * R15 L15-7 — the booking page's ONE column gap. At 56rem the page is two columns (Money and the
 * court column) under a Players block that spans both, whose two teams are two columns of their
 * own: the page's gap was 32px and the teams' 16px, so Team B stood 8px left of the column under
 * it. Both now take this token.
 */
export const DETAIL_GAP = "gap-8";
/** The same gap across only, for a grid whose rows keep their own (the teams' seats). */
export const DETAIL_COLUMN_GAP = "gap-x-8";
