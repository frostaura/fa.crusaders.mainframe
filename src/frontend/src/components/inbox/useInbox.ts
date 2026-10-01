import { useCallback, useEffect, useRef, useState } from "react";
import { playersEndpoints, type MemberNotification, type MemberNotificationPage } from "@/lib/playersApi";
import { INBOX_COPY } from "@/lib/playersCopy";
import { useToast } from "@/components/Toast";
import { describeFailure } from "@/lib/errors";
import { OfflineError, phoneIsOffline } from "@/lib/api";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { failureOf, knownUnchanged, markAllOrProve, markReadOrProve } from "./inboxReadBack";
import { memberReads } from "@/lib/offline/memberReads";
import { useCachedRead } from "@/lib/offline/useCachedRead";
import { useUnreadCount } from "./useUnreadCount";
import { dropMark, heldRead, holdMark, releaseMarks, settleMark, useHeldMarks, type HeldMarks } from "./heldMarks";

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

function useMarks(base: MemberNotificationPage | null, readAt: number | null, held: HeldMarks) {
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const current = marks.base === base ? marks : NO_MARKS;
  // A tapped notice's mark outlives this page (`heldMarks`): laid over a list read before it.
  const isUnread = useCallback(
    (n: MemberNotification) => n.read_at === null && !current.all && !current.ids.has(n.id) && !heldRead(held, n.id, readAt),
    [current, readAt, held],
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
  // R4 wave B — kept by `lib/offline`: drawn at once on a revisit, from the phone offline.
  const read = useCachedRead(memberReads.inbox.key, load);
  const retry = read.reload;
  const base = read.data;
  const unread = useUnreadCount();
  const { set: setCount, refresh: refreshCount } = unread;
  const older = useOlderPages(base);
  const readAt = read.readAt;
  const held = useHeldMarks();
  const marks = useMarks(base, readAt, held);

  // The page's figure is the server's own — the bell reads it too — less the tapped notices this
  // list was read too early to know about. Only a NEW list sets it: a mark made here moves the
  // count itself (`noteRead`).
  const heldNow = useRef(held);
  useEffect(() => { heldNow.current = held; }, [held]);
  useEffect(() => {
    if (!base) return;
    const early = (base.items ?? []).filter((n) => n.read_at === null && heldRead(heldNow.current, n.id, readAt)).length;
    setCount(Math.max(0, base.unread_count - early));
  }, [base, readAt, setCount]);
  useEffect(() => { if (base) releaseMarks(base.items ?? [], readAt); }, [base, readAt]);

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
    // On a phone this page is about to go: the mark is held past it until the club has it.
    holdMark(n.id);
    // Lost-reply audit (R3): a lost reply is read back; only a mark known not to have landed is undone.
    markReadOrProve(n.id).then(
      () => settleMark(n.id, true),
      (error: unknown) => {
        if (knownUnchanged(error)) { dropMark(n.id); marks.markId(n.id, false); } else settleMark(n.id, false);
        void refreshCount();
      },
    );
  }, [marks, noteRead, refreshCount]);

  const before = useRef<number | null>(null);
  const toast = useToast();
  // R5 M5-5 — the page already says "You're offline" (the club was never reached): Mark all read
  // is refused before sending, as every write is offline ("needs a connection… Nothing was sent"),
  // instead of a send that dies on the wire and a read-back that cannot look either.
  const unreachable = read.offline;
  const cannotSend = useCallback(() => unreachable || phoneIsOffline(), [unreachable]);
  // Lost-reply audit (R3): read back off the unread count; "Nothing changed" only when it is known.
  const markAll = useAsyncAction(() => (cannotSend() ? Promise.reject(new OfflineError()) : markAllOrProve()), {
    optimistic: {
      // Refused before sending: nothing is drawn as if it had been.
      apply: () => { before.current = cannotSend() ? null : countRef.current; if (before.current !== null) { marks.markAll(true); setCount(0); } },
      rollback: () => { if (before.current !== null) { marks.markAll(false); setCount(before.current); } },
    },
    failure: (error) => {
      const unchanged = knownUnchanged(error);
      toast.push({ tone: "danger", text: unchanged ? describeFailure(failureOf(error), { action: INBOX_COPY.markAllAction }) : INBOX_COPY.markUnknown, unchanged });
      void refreshCount();
    },
  });

  return {
    // Nothing to show yet: the list's skeleton or its failure. With a list in hand, a re-read
    // (`refreshing`) or a failed one (`stale`) is said beside it, never instead of it.
    loading: read.loading && base === null,
    error: base === null ? read.error : null,
    refreshing: read.loading,
    stale: read.stale,
    offline: read.offline,
    readAt: read.readAt,
    answered: base !== null,
    items: base ? [...(base.items ?? []), ...older.items] : [],
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
