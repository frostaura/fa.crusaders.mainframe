import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CaretRight, Envelope } from "@/components/ui/icons";
import { invitesWaitingLabel } from "@/lib/playersCopy";
import { cn } from "@/lib/utils";
import { useMyInvites } from "./useMyInvites";
import { usePendingLinkInvite } from "./usePendingLinkInvite";

/**
 * "2 invites waiting" — the Bookings page's way into Invites. Shown only at one or more: a badge
 * reading zero is noise, and a failed read shows nothing rather than a zero it does not know
 * (the Invites page itself says honestly when it cannot read). Navigation, so a link in a
 * button's clothes; the visible words ARE its accessible name.
 */
export function InvitesBadgeLink({ className }: { className?: string }) {
  const { items, count: listed } = useMyInvites();
  // R1 F2.3 / F2.5 — a link opened and not answered counts too: it is waiting on Invites.
  const pending = usePendingLinkInvite(items);
  const count = listed + (pending ? 1 : 0);
  if (count < 1) return null;
  const label = invitesWaitingLabel(count);
  return (
    <Button asChild variant="secondary" size="sm" className={cn("self-start", className)}>
      <Link to="/bookings/invites" data-invites-badge={count}>
        <Envelope size={16} weight="bold" aria-hidden="true" />
        <span>{label}</span>
        <CaretRight size={16} weight="bold" aria-hidden="true" />
      </Link>
    </Button>
  );
}
