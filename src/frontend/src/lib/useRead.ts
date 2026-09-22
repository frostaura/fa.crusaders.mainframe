import { useEffect, useState } from "react";

/**
 * One read, keyed by the attempt it belongs to — and its three states kept apart.
 *
 * <p>
 * Its own module rather than a helper inside a page, because every admin surface that reads
 * one thing and must not render "none" when it meant "we could not ask" needs exactly this,
 * and a second copy of it would drift from the first.
 * </p>
 */

/** What one read is: the data, why it failed, and whether the answer is still in flight. */
export type Read<T> = { data: T | null; error: unknown; loading: boolean };

/**
 * One read, keyed by the attempt it belongs to.
 *
 * <p>
 * The effect only STARTS a request; everything it learns is set from the promise's own
 * callback. Resetting three states at the top of an effect body is a cascading render the
 * React compiler cannot memoize around, and `react-hooks/set-state-in-effect` is an error in
 * this repo rather than a warning. Keyed, "loading" is the honest sentence "what I am holding
 * is not what I asked for".
 * </p>
 */
export function useRead<T>(key: string, load: () => Promise<T>): [Read<T>, () => void] {

  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ key: string; data: T | null; error: unknown }>(
    { key: "", data: null, error: null },
  );
  const asked = `${key}:${nonce}`;

  useEffect(() => {
    let live = true;
    load()
      .then((data) => { if (live) setState({ key: asked, data, error: null }); })
      .catch((error) => { if (live) setState({ key: asked, data: null, error }); });
    return () => { live = false; };
  }, [asked, load]);

  const fresh = state.key === asked;
  return [
    { data: fresh ? state.data : null, error: fresh ? state.error : null, loading: !fresh },
    () => setNonce((n) => n + 1),
  ];
}
