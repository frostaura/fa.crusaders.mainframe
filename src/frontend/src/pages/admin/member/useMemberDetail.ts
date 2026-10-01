import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { memberDetailEndpoints, type MemberDetail } from "@/lib/memberDetailApi";
import { MEMBER_COPY } from "@/lib/memberDetailCopy";
import { startMemberDetailReads } from "@/lib/offline/adminEarlyReads";
import { useDataOwner } from "@/lib/offline/useCachedRead";

/**
 * The one read the member-detail page is built on, and the context every tab takes it from.
 *
 * <p>
 * <b>A refresh keeps what it had.</b> `useRead` blanks its data while a new read is in flight,
 * which is right for a list keyed on a filter and wrong for a header: pressing Refresh, or a top-up
 * landing, would flash the person's name and balance to a skeleton and back. Here the previous
 * detail stays on screen while the next one is read, and only a change of PERSON clears it — a
 * header that outlives its subject for even one paint is somebody else's balance.
 * </p>
 *
 * <p>
 * <b>A failed refresh does not erase a good read either</b> — the header keeps the last answer and
 * the page says the refresh failed. A failed FIRST read has nothing to keep and renders the
 * failure with a retry; it is never an empty member.
 * </p>
 */
export type MemberDetailState = {
  userId: string;
  detail: MemberDetail | null;
  error: unknown;
  loading: boolean;
  /** When the detail on screen was read (epoch ms), for the header's freshness. */
  readAt: number | null;
  /** Re-read, keeping the current detail on screen meanwhile. */
  reload: () => Promise<void>;
  /** A local correction the server has already confirmed — a new balance, an admin flag. */
  patch: (next: Partial<MemberDetail>) => void;
};

type Held = { userId: string; detail: MemberDetail | null; error: unknown; readAt: number | null };

export function useMemberDetailRead(userId: string): MemberDetailState {
  const [held, setHeld] = useState<Held>({ userId, detail: null, error: null, readAt: null });
  const [inFlight, setInFlight] = useState(0);
  // Which person the page is on NOW, for a read that answers after the admin moved on.
  const latest = useRef(userId);
  useLayoutEffect(() => { latest.current = userId; }, [userId]);

  const reload = useCallback(async () => {
    const asked = userId;
    setInFlight((n) => n + 1);
    try {
      const detail = await memberDetailEndpoints.detail(asked);
      if (latest.current === asked) setHeld({ userId: asked, detail, error: null, readAt: Date.now() });
    } catch (error) {
      if (latest.current === asked) setHeld((prev) => (prev.userId === asked ? { ...prev, error } : { userId: asked, detail: null, error, readAt: null }));
    } finally {
      setInFlight((n) => n - 1);
    }
  }, [userId]);

  // P4-5 (R4 wave B) — the tabs' own reads start beside the detail, not a round trip after it.
  const { who } = useDataOwner();
  useEffect(() => { startMemberDetailReads(who, userId, window.location); }, [who, userId]);
  useEffect(() => { void reload(); }, [reload]);

  const patch = useCallback((next: Partial<MemberDetail>) => {
    setHeld((prev) => (prev.detail ? { ...prev, detail: { ...prev.detail, ...next } } : prev));
  }, []);

  const mine = held.userId === userId;
  return {
    userId,
    detail: mine ? held.detail : null,
    error: mine ? held.error : null,
    loading: inFlight > 0 || !mine,
    readAt: mine ? held.readAt : null,
    reload,
    patch,
  };
}

/** What a tab receives: the read, plus the page's shared actions. */
export type MemberDetailContext = MemberDetailState & {
  detail: MemberDetail;
  /** The member's display name, never "undefined" — see {@link displayName}. */
  name: string;
  /** Opens the Sell package sheet the header owns, so every tab sells through one idempotent path. */
  openSell: () => void;
};

export function useMemberDetail(): MemberDetailContext {
  return useOutletContext<MemberDetailContext>();
}

/** The name a screen prints: the membership's name, else the email, else a phrase naming nobody. */
export function displayName(detail: Pick<MemberDetail, "full_name" | "email"> | null): string {
  return detail?.full_name?.trim() || detail?.email || MEMBER_COPY.noName;
}

/** First name, for sentences that address the desk about the member ("Thandi has…"). */
export function firstName(name: string): string {
  return name.split(/\s+/)[0] || name;
}
