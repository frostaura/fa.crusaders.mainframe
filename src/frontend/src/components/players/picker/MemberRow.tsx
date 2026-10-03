import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Plus, Star } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { playersEndpoints, type PublicMember } from "@/lib/playersApi";
import { useToast } from "@/components/toastContext";
import { UnsureOutcome, writeOrReadBack } from "@/lib/lostReply";
import { PICKER, PLAYERS_UNSURE } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { cn } from "@/lib/utils";
import type { Favourites } from "./usePickerReads";

/**
 * One member in a picker list: the pick (photo, name, a line under it) and, beside it, the star.
 * Two buttons side by side, never one inside the other. A member already on the booking is shown
 * as "Added" and cannot be picked twice — the reason is the word, not a greyed-out row.
 */

export type MemberRowProps = {
  member: PublicMember;
  /** "Played 3 times · last on Tue 23 Sep". */
  detail?: string;
  added: boolean;
  favourites: Favourites;
  onPick: (member: PublicMember) => void;
};

export function MemberRow(props: MemberRowProps) {
  const { member, detail, added, favourites, onPick } = props;
  return (
    <li className="flex items-center gap-1" data-member-row={member.user_id}>
      <button
        type="button"
        aria-label={added ? `${member.name}, ${PICKER.added}` : PICKER.add(member.name)}
        aria-disabled={added || undefined}
        onClick={added ? undefined : () => onPick(member)}
        className={cn(
          "flex min-h-touch min-w-0 flex-1 items-center gap-3 rounded-lg border border-transparent px-2 py-1.5 text-left",
          "transition-colors duration-fast ease-standard motion-reduce:transition-none",
          added ? "cursor-default" : "hover:bg-bg-muted",
        )}
      >
        <Avatar size={40}>
          {member.photo_url ? <AvatarImage src={member.photo_url} alt="" /> : null}
          <AvatarFallback name={member.name} />
        </Avatar>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-semibold text-text-primary">{member.name}</span>
          {detail ? <span className="truncate text-xs text-text-secondary">{detail}</span> : null}
        </span>
        {added ? <Badge tone="neutral">{PICKER.added}</Badge> : <Plus size={16} aria-hidden="true" className="shrink-0 text-accent-strong" />}
      </button>
      <StarButton member={member} favourites={favourites} />
    </li>
  );
}

/**
 * The star, optimistic: it turns at once and turns back if the server says no. `aria-pressed`
 * carries the state; the fill weight carries it for the eye, so it never rests on colour.
 */
function StarButton({ member, favourites }: { member: PublicMember; favourites: Favourites }) {
  const starred = favourites.isStarred(member.user_id);
  const toast = useToast();
  // Lost-reply audit (R3): a lost reply is read back off the favourites; a star that did change stays.
  const action = useAsyncAction(
    (next: boolean) => writeOrReadBack(
      () => (next ? playersEndpoints.star(member.user_id) : playersEndpoints.unstar(member.user_id)),
      async () => {
        const has = (await playersEndpoints.favourites()).items.some((m) => m.user_id === member.user_id);
        return has === next ? { user_id: member.user_id, favourite: next } : null;
      },
    ),
    {
      optimistic: {
        apply: (next) => favourites.show(member, next),
        rollback: (next) => favourites.show(member, !next),
      },
      failure: (error) => {
        const unknown = error instanceof UnsureOutcome && !error.checked;
        toast.push({ tone: "danger", text: unknown ? PLAYERS_UNSURE.star(member.name) : PICKER.starFailed(member.name), unchanged: !unknown });
      },
    },
  );
  return (
    <IconButton
      label={starred ? PICKER.unstar(member.name) : PICKER.star(member.name)}
      aria-pressed={starred}
      pending={action.pending}
      onClick={() => void action.run(!starred)}
      className={starred ? "text-accent-strong" : "text-text-muted"}
    >
      <Star weight={starred ? "fill" : "regular"} aria-hidden="true" />
    </IconButton>
  );
}

/** Three rows shaped like the answer, while it is read. */
export function MemberRowsSkeleton() {
  return (
    <ul aria-hidden="true" className="grid gap-1">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex min-h-touch items-center gap-3 px-2 py-1.5">
          <Skeleton className="size-10 rounded-full" />
          <span className="grid flex-1 gap-1.5">
            <Skeleton className="h-4 w-32 rounded-sm" />
            <Skeleton className="h-3 w-24 rounded-sm" />
          </span>
        </li>
      ))}
    </ul>
  );
}
