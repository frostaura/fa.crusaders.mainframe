import type { MemberDoorContact } from "../../lib/api";
import { CONTACT_LEAD, contactMissingNotice } from "../../lib/memberDoorCopy";

/**
 * The club's number, on the page at all times rather than only on a refusal.
 *
 * <p>
 * "Shown on refusals" is the right emphasis and the wrong reachability. The member whose
 * every read has failed has no refusal card to hang a number on, and they are the person
 * who most needs one. Cost: one line of muted text. Benefit: the dead-end case stops
 * being a dead end.
 * </p>
 *
 * <p>
 * Both links are `min-h-11` rather than bare sixteen-pixel text. A cold thumb in the dark
 * does not aim, and a phone number that cannot be pressed at 06:00 is a phone number
 * nobody has.
 * </p>
 */
export function ClubContact({ contact }: { contact: MemberDoorContact }) {
  const phone = contact.phone;
  const email = contact.email;

  if (!phone && !email) {
    return <p className="text-xs text-text-muted">{contactMissingNotice()}</p>;
  }

  return (
    <div className="text-xs text-text-muted">
      <p>{CONTACT_LEAD}</p>
      {/* Stacked below `sm`, each its own 44px row; inline with a separator above it. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
        {phone && (
          <a href={`tel:${phone.replace(/\s+/g, "")}`}
             className="inline-flex items-center min-h-11 text-accent-strong underline underline-offset-2 hover:no-underline">
            {phone}
          </a>
        )}
        {phone && email && <span aria-hidden="true" className="hidden sm:inline">·</span>}
        {email && (
          <a href={`mailto:${email}`}
             className="inline-flex items-center min-h-11 break-all text-accent-strong underline underline-offset-2 hover:no-underline">
            {email}
          </a>
        )}
      </div>
    </div>
  );
}
