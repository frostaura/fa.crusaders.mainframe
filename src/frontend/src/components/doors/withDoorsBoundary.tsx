import type { ReactNode } from "react";
import { DoorsErrorBoundary } from "./DoorsErrorBoundary";

/**
 * Wraps one doors page in the boundary, at the page's own export.
 *
 * <p>
 * The routes live in `App.tsx`, which this lane does not own and which a sibling lane is
 * editing this round — so the wrapping happens where the page is defined rather than where it
 * is mounted. It also means a page is protected wherever it is rendered, including in the
 * tests that mount it directly.
 * </p>
 */
export function withDoorsBoundary<P extends object>(
  Page: (props: P) => ReactNode,
): (props: P) => ReactNode {
  return function Guarded(props: P) {
    return <DoorsErrorBoundary><Page {...props} /></DoorsErrorBoundary>;
  };
}
