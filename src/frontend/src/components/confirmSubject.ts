/**
 * What the way OUT is about, as a noun — from whichever of the three the call site gave.
 *
 * <p>
 * <b>C-M3, and the half of it that was still open.</b> The way out was named
 * <code>"Keep it open — Shut this door"</code>: a control whose whole job is to NOT do the
 * thing, named after the thing, with the destructive verb inside its own accessible name.
 * `subject` fixed it for the call sites that pass one. The doors console passes the door's name
 * through <code>ariaLabel</code> instead — <code>"Shut Side door"</code> — and those call sites
 * fell through to the idle label and got the defect back.
 * </p>
 *
 * <p>
 * So where there is an <code>ariaLabel</code> and no <code>subject</code>, the shared leading
 * WORDS are dropped: <code>"Shut Side door"</code> against <code>"Shut this door"</code> shares
 * <code>"Shut"</code>, leaving <code>"Side door"</code> — which is exactly what
 * <code>subject</code> would have said. Word boundaries, not characters: a character-wise
 * common prefix of those two strings is <code>"Shut "</code> plus nothing useful on other
 * pairs, and half a word in an accessible name is worse than none.
 * </p>
 *
 * <p>
 * It never returns empty. Where stripping would leave nothing — the label and the context are
 * the same words — the whole context is used, and where there is no context at all the idle
 * label is, which is the behaviour every call site had before `subject` existed.
 * </p>
 */
/**
 * Run-of-whitespace, hoisted — and hoisted for a REASON, not for reuse.
 *
 * <p>
 * `split(/\s+/)` inline made lizard's JavaScript tokeniser read the `/` as the start of a
 * regex it never closed, so `confirmSubject` was reported as spanning lines 176-930 — 97 NLOC
 * and 755 lines long — and the complexity gate failed on a ten-line function. The function is
 * CCN 7 and 23 lines; the measurement was the only thing over the limit, and silencing that
 * with a whitelist entry would have frozen a number that was never real. Hoisted, the parser
 * closes it and the file reports what it is.
 * </p>
 *
 * <p>
 * No flags, deliberately: a `g` regex carries `lastIndex` between calls, and a shared one
 * would return different answers for the same string depending on who called it last.
 * </p>
 */
const RUN_OF_SPACE = /\s+/;

export function confirmSubject(subject: string | undefined, ariaLabel: string | undefined, idleText: string): string {
  if (subject) return subject;
  if (!ariaLabel) return idleText;
  const label = idleText.split(RUN_OF_SPACE).filter(Boolean);
  const context = ariaLabel.split(RUN_OF_SPACE).filter(Boolean);
  let shared = 0;
  while (shared < label.length && shared < context.length && label[shared] === context[shared]) shared += 1;
  const rest = context.slice(shared).join(" ").trim();
  return rest || ariaLabel;
}
