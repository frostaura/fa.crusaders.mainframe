import type { Sentence } from "../../lib/memberDoorCopy";

/**
 * A sentence whose club number is a number a thumb can press. D13.
 *
 * <p>
 * <b>The defect this exists to close.</b> The self-check's conclusion and the message under
 * a code that has run out both ended "Phone the club on +27 21 555 0147." — as text. The
 * same number in the page footer, a few centimetres below, was a working `tel:` link. So the
 * two places a member reads it at their lowest ebb, one-handed and in the dark, were the two
 * places they had to memorise it and re-type it.
 * </p>
 *
 * <p>
 * The copy module builds a {@link Sentence} rather than a string precisely so that this can
 * be a link rather than a regular-expression hunt through finished prose for something that
 * looks like a phone number. `sentenceText` is the flattening in the other direction, which
 * is what the ban-list sweep reads.
 * </p>
 */
export function CopySentence({ sentence, className }: { sentence: Sentence; className?: string }) {
  return (
    <p className={className}>
      {sentence.text}
      {sentence.link && (
        <a
          href={sentence.link.href}
          // `inline` rather than the footer's `min-h-11` block: this one sits INSIDE a
          // sentence, and a 44px inline-flex anchor mid-paragraph tears the line box apart.
          // The underline and the colour are what make it findable; the footer's link is the
          // one built for a cold thumb, and it is still there.
          className="text-accent-strong underline underline-offset-2 hover:no-underline"
        >
          {sentence.link.text}
        </a>
      )}
      {sentence.tail}
    </p>
  );
}
