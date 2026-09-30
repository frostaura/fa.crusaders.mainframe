import { useState } from "react";
import type { ReadState } from "./usePickerReads";

/**
 * R1 F1.21 — which tab the picker opens on. Favourites is the first tab, but opening on an empty
 * Favourites made a member with no stars yet tap past it every time. So: Favourites when there
 * are any; else Recent when there is anyone; else Members. A read that FAILED is not "empty" —
 * Favourites stays, so its retry is what the member sees.
 *
 * <p>
 * <b>Decided once, then left alone.</b> Starring someone on Recent would otherwise flip the
 * picker back to Favourites under the member's finger. And a tab the member picked themselves
 * wins for the rest of the session (it is kept in `sessionStorage`, guarded — the picker works
 * without it and simply decides again).
 * </p>
 */

export type PickerTab = "favourites" | "recent" | "members" | "link" | "guest";

const KEY = "crusaders.playerPickerTab";
const TABS: readonly string[] = ["favourites", "recent", "members", "link", "guest"];

function remembered(): PickerTab | null {
  try {
    const value = window.sessionStorage.getItem(KEY);
    return value && TABS.includes(value) ? (value as PickerTab) : null;
  } catch {
    return null;
  }
}

function remember(tab: PickerTab): void {
  try {
    window.sessionStorage.setItem(KEY, tab);
  } catch {
    // Without storage the choice lasts as long as this picker does.
  }
}

/** The tab the reads point at, or null while they cannot tell yet. */
export function decideTab(favourites: ReadState<unknown[]>, recent: ReadState<unknown[]>): PickerTab | null {
  if (favourites.status === "error") return "favourites";
  if (favourites.status !== "ready") return null;
  if (favourites.data.length > 0) return "favourites";
  if (recent.status === "ready") return recent.data.length > 0 ? "recent" : "members";
  return recent.status === "error" ? "members" : null;
}

export function usePickerTab(favourites: ReadState<unknown[]>, recent: ReadState<unknown[]>) {
  const [picked, setPicked] = useState<PickerTab | null>(remembered);
  const [decided, setDecided] = useState<PickerTab | null>(null);
  const now = decideTab(favourites, recent);
  // Adjusting state while rendering (React's own pattern): the first decision sticks.
  if (decided === null && now !== null) setDecided(now);
  return {
    value: picked ?? decided ?? now ?? "favourites",
    choose: (tab: string) => {
      if (!TABS.includes(tab)) return;
      setPicked(tab as PickerTab);
      remember(tab as PickerTab);
    },
  };
}
