import { useId, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StateBlock } from "@/components/ui/state-block";
import { MagnifyingGlass, Star, UsersThree } from "@/components/ui/icons";
import { ApiError } from "@/lib/api";
import type { PublicMember, RecentPartner } from "@/lib/playersApi";
import { PICKER, playersRefusal, playersWhen } from "@/lib/playersCopy";
import { MemberRow, MemberRowsSkeleton } from "./MemberRow";
import { MIN_QUERY, useDirectory, useRecent, type Favourites } from "./usePickerReads";

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
      <ul aria-label={PICKER.favourites} className="grid gap-1">
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
  const day = playersWhen(p.last_played_at).split(",")[0];
  return `${played} · ${PICKER.lastPlayed(day)}`;
}

export function RecentTab(props: MemberTabProps) {
  const { favourites, excluded, onPick } = props;
  const recent = useRecent();
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
      <ul aria-label={PICKER.recent} className="grid gap-1">
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
    <div className="grid gap-3">
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
            <ul aria-label={PICKER.members} className="grid gap-1">
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
