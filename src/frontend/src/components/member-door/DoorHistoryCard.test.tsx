import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { DoorHistoryCard } from "./DoorHistoryCard";
import { renderPage, stubFetch } from "../../test/harness";
import { HISTORY_EMPTY, HISTORY_FAILED, HISTORY_RETRY } from "../../lib/memberDoorCopy";

/**
 * A door-history reply with no `items` list is a FAILED read, not an empty history.
 *
 * <p>
 * Read as `[]` it would tell the member they have never used a club door — a claim the page cannot
 * make — and dereferenced as it was, it threw during render and took the whole Profile page down.
 * Three states, not two: loading, failed (with a retry), and a real empty answer.
 * </p>
 */

const PATH = "/api/v1/me/door/history";

afterEach(() => vi.unstubAllGlobals());

describe("DoorHistoryCard", () => {
  it("shows the failed state, with a retry, when the reply carries no items", async () => {
    stubFetch([{ path: PATH, body: { next_cursor: null } }]);
    renderPage(<DoorHistoryCard />);

    expect(await screen.findByText(HISTORY_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(HISTORY_EMPTY)).toBeNull();
    expect(screen.getByRole("button", { name: HISTORY_RETRY })).toBeInTheDocument();
  });

  it("stays silent on the Profile's rows-only mode rather than crashing the page", async () => {
    stubFetch([{ path: PATH, body: {} }]);
    const { container } = renderPage(<DoorHistoryCard onlyWithRows />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector("#door-history, [role='region']")).toBeNull();
  });

  it("an empty list is still a real answer", async () => {
    stubFetch([{ path: PATH, body: { items: [], next_cursor: null } }]);
    renderPage(<DoorHistoryCard />);

    expect(await screen.findByText(HISTORY_EMPTY)).toBeInTheDocument();
  });
});
