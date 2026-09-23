import { Component, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "../ui/button";
import { Alert } from "../Alert";

/**
 * The last thing between a rendering fault on the doors surface and a blank white page.
 *
 * <p>
 * <b>A1 / E-C1 / C1, the critical of round 2.</b> A reviewer deleted a door; every scan row
 * it had ever written arrived with `door: null`; `AdminDoorsLogPage` read `.name` off it and
 * React unmounted the entire document. What the club saw was white — no heading, no message,
 * no navigation — and Back landed on `/schedule` rather than anywhere useful. Three reviewers
 * reached it independently, one of them through "Load older scans" with no link and no
 * warning that anything was different about that page of rows.
 * </p>
 *
 * <p>
 * <b>The null-handling is the fix; this is the floor under the next one.</b> A door surface
 * is read during an incident, by a volunteer, on a phone — the one moment a white screen is
 * least affordable — and the set of things a row can carry grows from the firmware and the
 * backend, never from here. So the page states are three (loading / failed / empty) and the
 * fourth, "this screen broke", is this.
 * </p>
 *
 * <p>
 * <b>It wraps the page ELEMENT, not the app.</b> The chrome — the header, the tab strip, the
 * shut-doors banner — lives above the router's `Outlet` and is untouched by a fault inside
 * one route, so an admin keeps every way out of this page that they had before it broke. A
 * boundary around `App` would take those with it, which is the white screen with extra steps.
 * </p>
 *
 * <p>
 * <b>And it resets on navigation.</b> Without that, a boundary that caught once goes on
 * showing its message over every doors route until a full reload — so the admin who follows
 * the "Back to Doors" link below lands on a working page that is still displaying the error
 * it recovered from. `useLocation().key` changes per navigation, and remounting on it is what
 * makes the way back actually work.
 * </p>
 */

type BoundaryProps = { children: ReactNode; onError?: (error: unknown) => void };

type BoundaryState = { failed: boolean };

class DoorsErrorBoundaryInner extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Reported rather than swallowed: a page that recovers silently is a defect nobody
    // hears about until a reviewer finds it again. There is no error-reporting service in
    // this product, so the console is where it goes.
    this.props.onError?.(error);
    console.error("A doors page failed to render.", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">This page could not be shown</h1>
        {/*
          What it says and what it refuses to say. It does NOT say the doors are fine — this
          screen has just proved it cannot read its own data, so a reassurance from it is
          worth nothing. It says what broke (the page), what did not (the doors and their
          records), and where to go.
        */}
        <Alert tone="danger">
          Something on this page could not be drawn, so it stopped rather than showing you half
          of it. Nothing at the doors has changed and no scan has been lost. Try the Doors page,
          or reload this one.
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/admin/monitoring/doors">Back to Doors</Link>
          </Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload this page
          </Button>
        </div>
      </div>
    );
  }
}

export function DoorsErrorBoundary({ children, onError }: BoundaryProps) {
  // Remount per navigation — see the note above. `key` on the class is the whole mechanism:
  // a boundary has no way to clear its own caught state from the outside.
  const { key } = useLocation();
  return <DoorsErrorBoundaryInner key={key} onError={onError}>{children}</DoorsErrorBoundaryInner>;
}

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
