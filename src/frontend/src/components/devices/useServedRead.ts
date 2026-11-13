import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";

/**
 * One read for a v3 panel, in four states: still reading, failed, not served (a `404` — an API
 * before v3, whose panel is then simply absent), and the answer. An empty answer is never
 * inferred from a failure.
 */
export type ServedRead<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** The API does not have this route: the panel renders nothing at all. */
  absent: boolean;
  reload: () => Promise<void>;
  set: (data: T) => void;
};

/** A reply of the wrong shape is a failed read, never data the panel would then render from. */
export class UnreadableReply extends Error {
  constructor() {
    super("unreadable_reply");
  }
}

const ANY_SHAPE = (): boolean => true;

/** `read` and `valid` must be stable (module-level or memoised): each is a dependency of the reload. */
export function useServedRead<T>(read: () => Promise<T>, valid: (data: unknown) => boolean = ANY_SHAPE): ServedRead<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [absent, setAbsent] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const answer = await read();
      if (!valid(answer)) throw new UnreadableReply();
      setData(answer);
      setAbsent(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setAbsent(true);
      else setError(err ?? new Error("unread"));
    } finally {
      setLoading(false);
    }
  }, [read, valid]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom
  useEffect(() => { void reload(); }, [reload]);

  return { data, error, loading, absent, reload, set: setData };
}
