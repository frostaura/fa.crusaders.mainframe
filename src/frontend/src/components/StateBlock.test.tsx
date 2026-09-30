import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StateBlock } from "./ui/state-block";
import { ApiError, NetworkError } from "../lib/api";

/**
 * The honest read, held as a component rather than as six correct copies.
 *
 * <p>
 * Every case below is an ORDERING claim, because that is where this class of defect actually
 * lives. Nobody writes "render the empty state on a failure"; they write four independent
 * guards and get them in the wrong order, and the test that would catch it is the one nobody
 * writes because each guard looks right on its own.
 * </p>
 */
describe("StateBlock — what a screen may claim", () => {
  it("says the read failed rather than that there is nothing, when both are true of its props", () => {
    // Exactly the shape that ships the defect: the list was initialised to [], so `empty` is
    // true, AND the read threw. One of these is a fact about the club and the other is a fact
    // about the request, and only one of them is known.
    render(
      <StateBlock
        error={new NetworkError("unreachable")}
        empty
        emptyTitle="No faults in the last 7 days."
        action="read the fault list"
        failedCaveat="That does not mean there are none."
      />,
    );

    expect(screen.queryByText(/No faults/), "an empty state over a failed read")
      .not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't be reached/i);
    expect(screen.getByRole("alert"), "the half a failure sentence leaves out")
      .toHaveTextContent("That does not mean there are none.");
  });

  it("says the read failed rather than rendering children it was also given", () => {
    render(
      <StateBlock error={new NetworkError("unreachable")} action="read the board">
        <p>Court 2 — lights on</p>
      </StateBlock>,
    );
    expect(screen.queryByText(/Court 2/)).not.toBeInTheDocument();
  });

  it("prefers the failure to the loading state, so a retry is reachable", () => {
    // A page that re-reads on a timer is `loading` again while showing the last failure. If
    // loading won, the retry would flicker out from under the pointer on every tick.
    const retry = vi.fn();
    render(<StateBlock loading error={new NetworkError("unreachable")} onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers no retry for a fault nobody reading it can act on", () => {
    render(
      <StateBlock
        error={new ApiError(404, { error: "tenant_not_found" })}
        onRetry={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Try again" }), "a button that cannot ever work")
      .not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/isn't set up/i);
  });

  /**
   * F4.4 — a transient 5xx says "Try again shortly", so it must carry the button that does. It
   * used to be treated as a deployment fault (every status ≥ 500), which left the sentence
   * asking for a retry the screen did not offer. Only the configuration codes drop it.
   */
  it.each([500, 502, 503, 504])("offers a retry beside a transient %i", (status) => {
    const retry = vi.fn();
    render(<StateBlock error={new ApiError(status, { error: "server_error" })} action="read the list" onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each([
    ["tenant_not_found", new ApiError(404, { error: "tenant_not_found" })],
    ["tenant_unresolved", new ApiError(400, { error: "tenant_unresolved" })],
    ["a 500 carrying tenant_not_found", new ApiError(500, { error: "tenant_not_found" })],
  ])("still offers no retry for %s", (_label, err) => {
    render(<StateBlock error={err} onRetry={() => {}} />);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("names what it is waiting for, in a region a screen reader is given", () => {
    render(<StateBlock loading action="read the club's plans" />);
    expect(screen.getByRole("status")).toHaveTextContent("Reading the club's plans…");
  });

  it("shows the empty state only when the read succeeded and said so", () => {
    render(
      <StateBlock empty emptyTitle="No repeating bookings yet." emptyHint="A plan holds Tuesday nights.">
        <p>a row that should not be here</p>
      </StateBlock>,
    );
    expect(screen.getByText("No repeating bookings yet.")).toBeInTheDocument();
    expect(screen.getByText("A plan holds Tuesday nights.")).toBeInTheDocument();
    expect(screen.queryByText(/should not be here/)).not.toBeInTheDocument();
  });

  it("renders what it has, with a band, rather than blanking a wall screen", () => {
    render(
      <StateBlock readAt="18:31" stale staleHint="The boxes may have moved on.">
        <p>Court 2 — lights on</p>
      </StateBlock>,
    );
    expect(screen.getByText(/Read at 18:31\./), "stale truth beats no truth").toBeInTheDocument();
    expect(screen.getByText("Court 2 — lights on")).toBeInTheDocument();
  });

  it("says nothing about freshness when the read is fresh", () => {
    render(<StateBlock readAt="18:31"><p>Court 2</p></StateBlock>);
    expect(screen.queryByText(/Read at/)).not.toBeInTheDocument();
  });

  /**
   * The mutant this kills: dropping the `readAt` half of the stale guard. A band that says
   * "Read at ." is worse than no band, because it looks like a bug rather than like a fact —
   * and an admin who has learned to ignore one warning has learned to ignore the next.
   */
  it("does not claim staleness it cannot date", () => {
    render(<StateBlock stale readAt={null}><p>Court 2</p></StateBlock>);
    expect(screen.queryByText(/Read at/)).not.toBeInTheDocument();
    expect(screen.getByText("Court 2")).toBeInTheDocument();
  });
});
