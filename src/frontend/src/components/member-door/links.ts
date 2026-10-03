import { buttonVariants } from "../ui/button-variants";
import { cn } from "../../lib/utils";

/**
 * The three ways a member's door surface may render something to press, and nothing else.
 * R3-36 (D-L3).
 *
 * <p>
 * <b>The finding: one surface, five spellings.</b> The page footer's link to the member's own
 * history, the club's number, the club's address and the "Book a court" link under the
 * standing line each carried their own copy of
 * `text-accent-strong underline underline-offset-2 hover:no-underline` — three of them with
 * `min-h-11`, one without, one with `text-sm` and one not — while the "What if the door is
 * offline?" disclosure ten pixels away was accent-coloured with no underline at all, and the
 * self-check's "Book a court" was a filled brand-coloured BUTTON for the same action the
 * standing line rendered as underlined text. A member reading down the page met the same
 * affordance drawn four different ways and the same ACTION drawn two.
 * </p>
 *
 * <p>
 * <b>Class strings, not components, and deliberately so.</b> The things being styled are a
 * router `Link`, a bare `<a href="tel:">`, an `<a>` inside a sentence and a `<summary>`; a
 * component per shape would be four components wrapping one string each. A constant is the
 * smallest thing that makes the five copies one, and Tailwind's scanner reads it because it
 * is a literal string rather than a template.
 * </p>
 */

/**
 * A link INSIDE a sentence — the club's number in a conclusion, an address in a dead end.
 *
 * <p>
 * No `min-h-11` on purpose: a 44px inline-flex anchor in the middle of a paragraph tears the
 * line box apart. The underline and the colour are what make it findable here, and
 * {@link MEMBER_DOOR_LINK_TAPPABLE} is the one built for a cold thumb.
 * </p>
 */
export const MEMBER_DOOR_LINK = "text-accent-strong underline underline-offset-2 hover:no-underline";

/**
 * A link that stands on its own line, with the 44px row the UX bar asks for.
 *
 * <p>
 * Used for the club's number and address in the footer, and for the way to the member's own
 * door history — every one of which is pressed one-handed, in the dark, by somebody who is
 * not aiming.
 * </p>
 */
export const MEMBER_DOOR_LINK_TAPPABLE =
  "inline-flex items-center min-h-11 text-sm text-accent-strong underline underline-offset-2 hover:no-underline";

/**
 * A router link that IS the next action — "Book a court", where a door has told the member
 * they need one.
 *
 * <p>
 * It looks like `Button variant="primary"` because it is doing that job — and since P3 it IS
 * that look, derived from `buttonVariants` rather than a hand-copied class string that had
 * drifted to the brand fill — the `<Button asChild><Link/></Button>` navigation-CTA shape
 * (design-system.md, Buttons vs links). It is an anchor rather than a button because it
 * navigates, and a member should be able to open it in another tab. The one rule this constant enforces is that the SAME action is never a filled
 * button in one block and underlined text in another, which is what the self-check and the
 * standing line were doing to "Book a court".
 * </p>
 */
// `!h-auto whitespace-normal`: the primitive is a fixed-height, no-wrap control, and this page is
// measured at a 32 px root font on a 360 px phone (e2e/my-code) — the label must wrap, not push.
export const MEMBER_DOOR_ACTION_LINK = cn(
  buttonVariants({ variant: "primary" }),
  "!h-auto min-h-touch whitespace-normal py-2 text-center w-full sm:w-auto",
);

/**
 * The same wrap rule for a door-page `Button` (the action, not the link): a floor of 44 px, not a
 * fixed height, and a label that breaks rather than pushing the row sideways at a 32 px root.
 */
export const MEMBER_DOOR_BUTTON = "h-auto min-h-touch whitespace-normal py-2 text-center";
