import { useCallback, useEffect, useRef, useState } from "react";
import { playersEndpoints, type MemberNotification, type MemberNotificationPage } from "@/lib/playersApi";
import { INBOX_COPY } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useRead } from "@/lib/useRead";
import { useUnreadCount } from "./useUnreadCount";

/**
 * The member's inbox as one read (P11): the newest page, older pages appended by keyset cursor,
 * and the member's own marks laid over both — optimistically, rolled back if the server refuses.
 *
 * <p>
 * Everything local is keyed on the FIRST page it belongs to, as `useRecentAlerts` does: a refresh
 * drops the older pages and the local marks rather than splicing a new head onto an old tail.
 * The first page's `unread_count` is the server's own figure, and goes straight into the shared
 * store the bell reads.
 * </p>
 */

type Older = { base: MemberNotificationPage | null; items: MemberNotification[]; cursor: string | null };
type Marks = { base: MemberNotificationPage | null; ids: ReadonlySet<string>; all: boolean };

const NO_MARKS: Marks = { base: null, ids: new Set(), all: false };

function useOlderPages(base: MemberNotificationPage | null) {
  const [older, setOlder] = useState<Older>({ base: null, items: [], cursor: null });
  const follows = base !== null && older.base === base;
  const cursor = follows ? older.cursor : base?.next_cursor ?? null;
  const more = useAsyncAction(async () => {
    if (!base || !cursor) return;
    const page = await playersEndpoints.notifications(cursor);
    setOlder((prev) => ({ base, items: [...(prev.base === base ? prev.items : []), ...page.items], cursor: page.next_cursor }));
  });
  return { items: follows ? older.items : [], cursor, more };
}

function useMarks(base: MemberNotificationPage | null) {
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const current = marks.base === base ? marks : NO_MARKS;
  const isUnread = useCallback(
    (n: MemberNotification) => n.read_at === null && !current.all && !current.ids.has(n.id),
    [current],
  );
  const markId = useCallback((id: string, on: boolean) => setMarks((prev) => {
    const ids = new Set(prev.base === base ? prev.ids : []);
    if (on) ids.add(id); else ids.delete(id);
    return { base, ids, all: prev.base === base && prev.all };
  }), [base]);
  const markAll = useCallback((on: boolean) => setMarks((prev) => ({
    base, ids: prev.base === base ? prev.ids : new Set<string>(), all: on,
  })), [base]);
  return { isUnread, markId, markAll };
}

export function useInbox() {
  const load = useCallback(() => playersEndpoints.notifications(), []);
  const [read, retry] = useRead("member-notifications", load);
  const base = read.data;
  const unread = useUnreadCount();
  const { set: setCount, refresh: refreshCount } = unread;
  const older = useOlderPages(base);
  const marks = useMarks(base);

  // The page's figure is the server's own — the bell reads it too.
  useEffect(() => {
    if (base) setCount(base.unread_count);
  }, [base, setCount]);

  const count = unread.count ?? base?.unread_count ?? 0;
  const countRef = useRef(count);
  useEffect(() => { countRef.current = count; }, [count]);

  /** Optimistic: the row reads as read and the bell drops by one at once. */
  const noteRead = useCallback((n: MemberNotification, on: boolean) => {
    marks.markId(n.id, on);
    countRef.current = Math.max(0, countRef.current + (on ? -1 : 1));
    setCount(countRef.current);
  }, [marks, setCount]);

  /** Tapping a notice that opens somewhere: mark it read, fire-and-forget; a refusal re-reads. */
  const openedUnread = useCallback((n: MemberNotification) => {
    if (!marks.isUnread(n)) return;
    noteRead(n, true);
    playersEndpoints.markRead(n.id).catch(() => { marks.markId(n.id, false); void refreshCount(); });
  }, [marks, noteRead, refreshCount]);

  const before = useRef(0);
  const markAll = useAsyncAction(() => playersEndpoints.markAllRead(), {
    optimistic: {
      apply: () => { before.current = countRef.current; marks.markAll(true); setCount(0); },
      rollback: () => { marks.markAll(false); setCount(before.current); },
    },
    toast: { action: INBOX_COPY.markAllAction, unchanged: true },
  });

  return {
    loading: read.loading,
    error: read.error,
    answered: base !== null,
    items: base ? [...base.items, ...older.items] : [],
    cursor: older.cursor,
    more: older.more,
    count,
    isUnread: marks.isUnread,
    noteRead,
    openedUnread,
    markAll,
    retry,
  };
}

export type InboxFeed = ReturnType<typeof useInbox>;
