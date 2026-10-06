import { useId, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StateBlock } from "@/components/ui/state-block";
import { MagnifyingGlass, Star, UsersThree } from "@/components/ui/icons";
import { ApiError } from "@/lib/api";
import type { PublicMember, RecentPartner } from "@/lib/playersApi";
import { clubShortDate } from "@/lib/clubClock";
import { PICKER, playersRefusal } from "@/lib/playersCopy";
import { MemberRow, MemberRowsSkeleton } from "./MemberRow";
import { MIN_QUERY, useDirectory, type useRecent, type Favourites } from "./usePickerReads";

/**
 * The three member tabs — Favourites, Recent, Members. Each is the honest read (failed ·
 * reading · empty · the list) through `StateBlock`, and each row is a `MemberRow`.
 */

export type MemberTabProps = {
  favourites: Favourites;
  /** Members already on the booking, and the viewer — shown as added, never pickable. */
  excluded: ReadonlySet<string>;
  onPick: (member: PublicMember) => void;
};

/** A refusal's own sentence (with its figures) for `StateBlock`, which otherwise says it generically. */
function codesFor(error: unknown): Record<string, string> | undefined {
  return error instanceof ApiError && error.code ? { [error.code]: playersRefusal(error) } : undefined;
}

export function FavouritesTab(props: MemberTabProps) {
  const { favourites, excluded, onPick } = props;
  const { state } = favourites;
  return (
    <StateBlock
      loading={state.status === "loading"}
      error={state.status === "error" ? state.error : null}
      codes={state.status === "error" ? codesFor(state.error) : undefined}
      action={PICKER.favouritesAction}
      onRetry={favourites.retry}
      empty={state.status === "ready" && favourites.listed.length === 0}
      emptyTitle={PICKER.favouritesEmpty}
      emptyHint={PICKER.favouritesEmptyHint}
      emptyIcon={Star}
      skeleton={<MemberRowsSkeleton />}
    >
      <ul aria-label={PICKER.favourites} className="grid grid-cols-[minmax(0,1fr)] gap-1">
        {favourites.listed.map((m) => (
          <MemberRow key={m.user_id} member={m} added={excluded.has(m.user_id)} favourites={favourites} onPick={onPick} />
        ))}
      </ul>
    </StateBlock>
  );
}

function recentDetail(p: RecentPartner): string {
  const played = PICKER.played(p.games);
  if (!p.last_played_at) return played;
  const day = clubShortDate(p.last_played_at);
  return `${played} · ${PICKER.lastPlayed(day)}`;
}

/** Recent is read by the picker itself (it decides the opening tab), and handed in. */
export function RecentTab(props: MemberTabProps & { recent: ReturnType<typeof useRecent> }) {
  const { favourites, excluded, onPick, recent } = props;
  const { state } = recent;
  const rows = state.status === "ready" ? state.data : [];
  return (
    <StateBlock
      loading={state.status === "loading"}
      error={state.status === "error" ? state.error : null}
      codes={state.status === "error" ? codesFor(state.error) : undefined}
      action={PICKER.recentAction}
      onRetry={recent.retry}
      empty={state.status === "ready" && rows.length === 0}
      emptyTitle={PICKER.recentEmpty}
      emptyHint={PICKER.recentEmptyHint}
      emptyIcon={UsersThree}
      skeleton={<MemberRowsSkeleton />}
    >
      <ul aria-label={PICKER.recent} className="grid grid-cols-[minmax(0,1fr)] gap-1">
        {rows.map((p) => (
          <MemberRow
            key={p.user_id} member={p} detail={recentDetail(p)}
            added={excluded.has(p.user_id)} favourites={favourites} onPick={onPick}
          />
        ))}
      </ul>
    </StateBlock>
  );
}

/** What the live region says: nothing while typing or reading, then the count — or no one. */
function searchAnnouncement(state: { status: string } | null, count: number): string {
  if (state?.status !== "ready") return "";
  return count > 0 ? PICKER.searchFound(count) : PICKER.searchNoneFound;
}

/**
 * The club directory (D13): nothing is asked below two characters or while still typing (300 ms
 * after the last key), and an empty answer says WHY it may be empty — only members who opted in
 * to being found appear, so "no one found" is never read as "no such member".
 */
export function MembersTab(props: MemberTabProps) {
  const { favourites, excluded, onPick } = props;
  const [query, setQuery] = useState("");
  const search = useDirectory(query);
  const { state } = search;
  const short = query.trim().length < MIN_QUERY;
  const rows = state.status === "ready" ? state.data : [];
  const resultsId = useId();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <Field>
        <FieldLabel>{PICKER.searchLabel}</FieldLabel>
        <div className="relative">
          <MagnifyingGlass size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input
            type="search"
            value={query}
            autoComplete="off"
            maxLength={64}
            placeholder={PICKER.searchPlaceholder}
            aria-controls={resultsId}
            className="pl-10"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {short ? <FieldDescription>{PICKER.searchHint}</FieldDescription> : null}
      </Field>
      {/* Always mounted, so the count is ANNOUNCED when it changes rather than arriving silently with the list (a11y). */}
      <p aria-live="polite" className="sr-only">{searchAnnouncement(short || search.typing ? null : state, rows.length)}</p>
      <div id={resultsId}>
        {short ? null : (
          <StateBlock
            loading={state.status === "loading" || state.status === "idle" || search.typing}
            error={state.status === "error" && !search.typing ? state.error : null}
            codes={state.status === "error" ? codesFor(state.error) : undefined}
            action={PICKER.searchAction}
            onRetry={search.retry}
            empty={state.status === "ready" && rows.length === 0}
            emptyTitle={PICKER.searchEmpty}
            emptyHint={PICKER.searchEmptyHint}
            emptyIcon={UsersThree}
            skeleton={<MemberRowsSkeleton />}
          >
            <ul aria-label={PICKER.members} className="grid grid-cols-[minmax(0,1fr)] gap-1">
              {rows.map((m) => (
                <MemberRow key={m.user_id} member={m} added={excluded.has(m.user_id)} favourites={favourites} onPick={onPick} />
              ))}
            </ul>
          </StateBlock>
        )}
      </div>
    </div>
  );
}
