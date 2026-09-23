/**
 * The honest read — loading · failed · empty · stale · the thing itself — now lives in
 * `components/ui/state-block.tsx`, whose API is a superset of the one this file carried.
 *
 * <p>
 * This file is a COMPAT re-export so the call sites that import `components/StateBlock` keep
 * compiling unchanged. Every rule the old component held is kept there: failed before empty,
 * always (an empty collection is not an answer); failed before loading so a retry is not
 * snatched away by a poll; no retry for a deployment fault; stale is a band above real content,
 * never claimed without a time. Deleted with the other shims in P10.
 * </p>
 */
export { StateBlock, type StateBlockProps } from "./ui/state-block";
