import { UnsureOutcome, writeOrReadBack, type Landed } from "@/lib/lostReply";
import { playersEndpoints } from "@/lib/playersApi";

/**
 * The lost-reply audit (R3) of the inbox's two writes. A mark whose reply was lost is read back —
 * the unread count for "Mark all read", the newest page for one notice — so a mark that DID land is
 * never rolled back with "Nothing changed".
 */
export function markAllOrProve(): Promise<Landed<{ marked: number }>> {
  return writeOrReadBack(
    () => playersEndpoints.markAllRead(),
    async () => ((await playersEndpoints.unreadCount()).unread_count === 0 ? { marked: 0 } : null),
  );
}

export function markReadOrProve(id: string): Promise<Landed<{ id: string; read: boolean }>> {
  return writeOrReadBack(
    () => playersEndpoints.markRead(id),
    async () => {
      const notice = (await playersEndpoints.notifications()).items.find((n) => n.id === id);
      // Not on the newest page: nothing to judge by — said as not known, never as "nothing changed".
      if (!notice) throw new Error("not on the newest page");
      return notice.read_at ? { id, read: true } : null;
    },
  );
}

/** Whether a failed mark is known to have changed nothing (a refusal, or a look that found it unread). */
export function knownUnchanged(error: unknown): boolean {
  return !(error instanceof UnsureOutcome) || error.checked;
}

/** The failure to word: a lost reply's own transport failure, or the refusal itself. */
export function failureOf(error: unknown): unknown {
  return error instanceof UnsureOutcome ? error.original : error;
}
