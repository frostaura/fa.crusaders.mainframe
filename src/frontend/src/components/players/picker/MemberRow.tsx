import { useId } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Plus, Star } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { playersEndpoints, type PublicMember } from "@/lib/playersApi";
import { useToast } from "@/components/toastContext";
import { UnsureOutcome, unsureReasonOf, writeOrReadBack } from "@/lib/lostReply";
import { PICKER, PLAYERS_UNSURE } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { cn } from "@/lib/utils";
import type { Favourites } from "./usePickerReads";
import { namesakeDetail } from "./namesake";
import { keepFiguresWhole } from "@/components/ui/figure-text";

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
  const { member, added, favourites, onPick } = props;
  // R16 J16-3 — a row without a line of its own says what tells namesakes apart; the line is the
  // button's description, so it is heard as well as seen.
  const detail = props.detail ?? namesakeDetail(member);
  const detailId = useId();
  return (
    // R18 L18-1 — the row is its own container: where photo, name, "+" and star cannot share a line
    // with room for the words (a 320 px phone at 150–200 % text) the words take the row's whole width
    // under the photo, instead of a ~56px column that broke "Member since" mid-word.
    <li className="@container/row flex items-center gap-1" data-member-row={member.user_id}>
      <button
        type="button"
        aria-label={added ? `${member.name}, ${PICKER.added}` : PICKER.add(member.name)}
        aria-disabled={added || undefined}
        aria-describedby={detail ? detailId : undefined}
        onClick={added ? undefined : () => onPick(member)}
        className={cn(ROW_GRID, "min-h-touch min-w-0 flex-1 rounded-lg border border-transparent px-2 py-1.5 text-left",
          "transition-colors duration-fast ease-standard motion-reduce:transition-none",
          added ? "cursor-default" : "hover:bg-bg-muted",
        )}
      >
        <Avatar size={40}>
          {member.photo_url ? <AvatarImage src={member.photo_url} alt="" /> : null}
          <AvatarFallback name={member.name} />
        </Avatar>
        <span className={ROW_WORDS}>
          {/* Two lines of name before an ellipsis — never "Ch…" — and a word breaks only if alone it cannot fit. */}
          <span data-member-name="" className="line-clamp-2 break-words text-sm font-semibold text-text-primary">{member.name}</span>
          {/* R17 (CI class) — "6 Oct 2026" never splits its figure from its unit; the paint is glued. */}
          {detail ? <span id={detailId} data-member-detail="" className="break-words text-xs text-text-secondary">{keepFiguresWhole(detail)}</span> : null}
        </span>
        <span className={ROW_MARK}>
          {added ? <Badge tone="neutral">{PICKER.added}</Badge> : <Plus size={16} aria-hidden="true" className="shrink-0 text-accent-strong" />}
        </span>
      </button>
      <StarButton member={member} favourites={favourites} />
    </li>
  );
}

/**
 * R18 L18-1 — written whole, so Tailwind's scanner sees every class. Narrow (under 15 root ems of
 * row, 240px at 100 % and 480px at 200 %): photo and mark on the first line, the words
 * under them across the row. Wide: photo · words · mark on one line, as before.
 */
const ROW_GRID = "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 @[15rem]/row:grid-cols-[auto_minmax(0,1fr)_auto]";
const ROW_WORDS = "col-span-2 row-start-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5 @[15rem]/row:col-span-1 @[15rem]/row:col-start-2 @[15rem]/row:row-start-1";
const ROW_MARK = "col-start-2 row-start-1 flex justify-self-end @[15rem]/row:col-start-3";

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
        // R18 X18-1 / R19 X19-2 — a clash, a busy club and a plain 500 are answers, never "the club didn't answer".
        const unsure = unknown ? { busy: PLAYERS_UNSURE.starBusy, conflict: PLAYERS_UNSURE.starConflict, error: PLAYERS_UNSURE.starError, silent: PLAYERS_UNSURE.star }[unsureReasonOf(error)] : PLAYERS_UNSURE.star;
        toast.push({ tone: "danger", text: unknown ? unsure(member.name) : PICKER.starFailed(member.name), unchanged: !unknown });
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
    <ul aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)] gap-1">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex min-h-touch items-center gap-3 px-2 py-1.5">
          <Skeleton className="size-10 rounded-full" />
          <span className="grid grid-cols-[minmax(0,1fr)] flex-1 gap-1.5">
            <Skeleton className="h-4 w-32 rounded-sm" />
            <Skeleton className="h-3 w-24 rounded-sm" />
          </span>
        </li>
      ))}
    </ul>
  );
}
