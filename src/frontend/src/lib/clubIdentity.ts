import { useSyncExternalStore } from "react";
import { endpoints } from "./api";

/**
 * Which club this address serves — the name in the crest, on the sign-in band, on the pass and in
 * every tab title (go-live FM-8).
 *
 * <p>
 * <b>Tenant data, never a literal.</b> The app named "Crusaders Squash" in all four places in a
 * product that is multi-tenant by construction, so a second club's members would have signed in to
 * Crusaders. The name comes from `GET /api/v1/auth/club` (the club's own `Tenant.DisplayName`, the
 * one its emails use), read once per page load, and is kept on this phone so the next visit paints
 * it at once. localStorage is per origin, and a club is per host, so one club's name cannot reach
 * another club's address.
 * </p>
 *
 * <p>
 * <b>Unknown is a state, not a default.</b> Before the first answer on a phone that has never had
 * one, and after a read that failed with nothing kept, there is no name — and the chrome says
 * nothing rather than borrowing one. A failed read keeps what the phone already knew.
 * </p>
 */
export type ClubIdentity = { slug: string; name: string };

type State = { club: ClubIdentity | null; settled: boolean };

const KEPT_KEY = "crusaders.mainframe.club";
/** What the API answers for a club row with no display name; treated as no name at all. */
const NO_NAME = "the club";

function readKept(): ClubIdentity | null {
  try {
    const raw = window.localStorage.getItem(KEPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClubIdentity>;
    return typeof parsed.slug === "string" && typeof parsed.name === "string" && parsed.name.trim() ? { slug: parsed.slug, name: parsed.name } : null;
  } catch {
    return null;
  }
}

function keep(club: ClubIdentity) {
  try { window.localStorage.setItem(KEPT_KEY, JSON.stringify(club)); } catch { /* storage refused: this visit still has it */ }
}

let state: State = { club: readKept(), settled: false };
const listeners = new Set<() => void>();
let asked: Promise<void> | null = null;

function publish(next: State) {
  state = next;
  for (const fn of listeners) fn();
}

function usable(answer: { slug?: unknown; name?: unknown } | null | undefined): ClubIdentity | null {
  if (!answer || typeof answer.name !== "string" || typeof answer.slug !== "string") return null;
  const name = answer.name.trim();
  return name && name.toLowerCase() !== NO_NAME ? { slug: answer.slug, name } : null;
}

/** Ask once per page load; later calls join it. Never rejects. */
export function loadClubIdentity(): Promise<void> {
  asked ??= endpoints.club().then(
    (answer) => {
      const club = usable(answer);
      if (club) keep(club);
      publish({ club: club ?? state.club, settled: true });
    },
    () => publish({ ...state, settled: true }),
  );
  return asked;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const snapshot = () => state;

/** The club and whether the read has answered (either way). */
export function useClubIdentity(): State {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** "Crusaders Squash Club" → "Crusaders Squash": the name the bar, the pass and a tab title carry. */
export function shortClubName(name: string): string {
  const short = name.replace(/\s+club$/i, "").trim();
  return short || name;
}

/** The short name, or null while unknown. */
export function useClubShortName(): string | null {
  const { club } = useClubIdentity();
  return club ? shortClubName(club.name) : null;
}

/** For code outside React (the document title): the short name now, or null. */
export function currentClubShortName(): string | null {
  return state.club ? shortClubName(state.club.name) : null;
}

/** Subscribe outside React (the route announcer re-titles the tab when the name arrives). */
export const subscribeClubIdentity = subscribe;

/** Tests: put a club in place (or none), as a kept answer would. */
export function setClubIdentityForTests(club: ClubIdentity | null, settled = true): void {
  asked = null;
  publish({ club, settled });
}
