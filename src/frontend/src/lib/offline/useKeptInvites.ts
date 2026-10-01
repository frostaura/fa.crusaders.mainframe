import { useCallback } from "react";
import type { MyInvites } from "@/components/players/invites/useMyInvites";
import type { Invite } from "../playersApi";
import { memberReads } from "./memberReads";
import { fetchQuery } from "./queryCache";
import { useCachedRead, useDataOwner } from "./useCachedRead";

/**
 * R5 M5-6 — the member's open invites, kept per member by `lib/offline` like the other member
 * reads: drawn at once on a revisit, from the phone offline (with its "as of"), and asked again
 * behind it. Same shape as `useMyInvites` (three states: `items` null until something answered),
 * plus the stale/offline pair a `StaleNotice` says.
 *
 * <p>
 * `refresh` resolves once the club has answered (the accept flow waits on it before it reads a
 * risen share), with the fresh list or null on a failure — the hook's own read joins the same
 * request, so the failure is also said beside the list.
 * </p>
 */
export type KeptInvites = MyInvites & { stale: boolean; offline: boolean };

const { key, load } = memberReads.invites;

function itemsOf(answer: { items?: Invite[] } | null | undefined): Invite[] {
  return Array.isArray(answer?.items) ? answer.items : [];
}

export function useKeptInvites(): KeptInvites {
  const { who } = useDataOwner();
  const read = useCachedRead(key, load);
  const { reload } = read;
  const refresh = useCallback(() => {
    const asked = fetchQuery(who, key, load);
    // The hook's own read joins the one in flight: a failure is said beside the list too.
    reload();
    return asked.then(itemsOf, () => null);
  }, [who, reload]);
  const items = read.data ? itemsOf(read.data) : null;
  return {
    items,
    count: items?.length ?? 0,
    loading: read.loading,
    error: read.error,
    readAt: read.readAt,
    refresh,
    stale: read.stale,
    offline: read.offline,
  };
}
