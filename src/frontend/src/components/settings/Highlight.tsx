import type { ReactNode } from "react";

/**
 * The words a search matched, marked where they sit in a caption.
 *
 * <p>
 * A `<mark>` rather than a coloured span: it is the element that MEANS "relevant to what you are
 * looking for", and it keeps the caption's own text intact — a label read by `getByLabelText` or a
 * screen reader is still exactly the caption, with or without a search running.
 * </p>
 */
export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(query, from); at >= 0; at = lower.indexOf(query, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-warning-soft text-text-primary">{text.slice(at, at + query.length)}</mark>,
    );
    from = at + query.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}
