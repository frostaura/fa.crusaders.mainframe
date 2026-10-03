import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StateBlock } from "../state-block";
import { Skeleton } from "../skeleton";
import { CalendarBlank } from "../icons";
import { ApiError, NetworkError } from "@/lib/api";

const strict = { reactStrictMode: true };

/**
 * The restyled StateBlock keeps every ordering claim `components/StateBlock.test.tsx` makes of
 * the old one (so the integrate lane can re-export it), and adds the skeleton and empty-state
 * slots.
 */
describe("StateBlock (ui) — the old component's claims, kept", () => {
  it("says the read failed rather than that there is nothing, when both are true of its props", () => {
    render(
      <StateBlock
        error={new NetworkError("unreachable")}
        empty
        emptyTitle="No faults in the last 7 days."
        action="read the fault list"
        failedCaveat="That does not mean there are none."
      />,
      strict,
    );
    expect(screen.queryByText(/No faults/)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't be reached/i);
    expect(screen.getByRole("alert")).toHaveTextContent("That does not mean there are none.");
  });

  it("says the read failed rather than rendering children it was also given", () => {
    render(<StateBlock error={new NetworkError("unreachable")}><p>Court 2 — lights on</p></StateBlock>);
    expect(screen.queryByText(/Court 2/)).not.toBeInTheDocument();
  });

  it("prefers the failure to the loading state, so a retry is reachable", () => {
    const retry = vi.fn();
    render(<StateBlock loading error={new NetworkError("unreachable")} onRetry={retry} />);
    const button = screen.getByRole("button", { name: "Try again" });
    expect(button.className).toContain("h-touch");
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers no retry for a fault nobody reading it can act on", () => {
    render(<StateBlock error={new ApiError(404, { error: "tenant_not_found" })} onRetry={() => {}} />);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/isn't set up/i);
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
    render(<StateBlock readAt="18:31" stale staleHint="The boxes may have moved on."><p>Court 2 — lights on</p></StateBlock>);
    expect(screen.getByText(/Read at 18:31\./)).toHaveTextContent("The boxes may have moved on.");
    expect(screen.getByText("Court 2 — lights on")).toBeInTheDocument();
  });

  it("says nothing about freshness when the read is fresh, or cannot be dated", () => {
    const { rerender } = render(<StateBlock readAt="18:31"><p>Court 2</p></StateBlock>);
    expect(screen.queryByText(/Read at/)).not.toBeInTheDocument();
    rerender(<StateBlock stale readAt={null}><p>Court 2</p></StateBlock>);
    expect(screen.queryByText(/Read at/)).not.toBeInTheDocument();
    expect(screen.getByText("Court 2")).toBeInTheDocument();
  });
});

describe("StateBlock (ui) — the new slots", () => {
  it("shows a layout-shaped skeleton while loading, busy, with the sentence kept for screen readers", () => {
    render(<StateBlock loading action="read your bookings" skeleton={<Skeleton data-testid="bone" className="h-12" />} />);
    const region = document.querySelector<HTMLElement>("[data-state-block=loading]")!;
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("bone")).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Reading your bookings…");
    expect(status.className).toContain("sr-only");
  });

  it("draws the empty state's 2.5rem duotone icon (40px at 100 %, growing with the text), and its next step", () => {
    render(
      <StateBlock
        empty
        emptyIcon={CalendarBlank}
        emptyTitle="No bookings yet."
        emptyAction={<button type="button">Book a court</button>}
      />,
    );
    const block = document.querySelector<HTMLElement>("[data-state-block=empty]")!;
    const icon = block.querySelector("svg")!;
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("width", "2.5rem");
    expect(screen.getByRole("button", { name: "Book a court" })).toBeInTheDocument();
  });

  it("says 'Nothing here yet.' when the call site has no words of its own", () => {
    render(<StateBlock empty />);
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
  });

  it("lets the retry be named", () => {
    render(<StateBlock error={new NetworkError("unreachable")} onRetry={() => {}} retryLabel="Read the board again" />);
    expect(screen.getByRole("button", { name: "Read the board again" })).toBeInTheDocument();
  });
});
