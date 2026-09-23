import { useCallback, useState } from "react";
import { notificationsEndpoints, type AdminNotice, type AdminNoticePage } from "@/lib/notificationsApi";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useRead } from "@/lib/useRead";

type Extra = { base: AdminNoticePage | null; items: AdminNotice[]; cursor: string | null };

/**
 * The first page, keyed on `nonce` (the Overview's refresh), and the older pages appended to THAT
 * first page only — a refresh drops them rather than splicing a new head onto an old tail.
 */
export function useRecentAlerts() {
  const load = useCallback(() => notificationsEndpoints.feed(), []);
  const [read, retry] = useRead("admin-notifications", load);
  const [extra, setExtra] = useState<Extra>({ base: null, items: [], cursor: null });
  const base = read.data;
  const follows = base !== null && extra.base === base;
  const cursor = follows ? extra.cursor : base?.next_cursor ?? null;

  const more = useAsyncAction(async () => {
    if (!base || !cursor) return;
    const page = await notificationsEndpoints.feed(cursor);
    setExtra((prev) => ({ base, items: [...(prev.base === base ? prev.items : []), ...page.items], cursor: page.next_cursor }));
  });

  return {
    loading: read.loading,
    error: read.error,
    items: base ? [...base.items, ...(follows ? extra.items : [])] : [],
    answered: base !== null,
    cursor,
    more,
    retry,
  };
}

export type RecentAlertsFeed = ReturnType<typeof useRecentAlerts>;

