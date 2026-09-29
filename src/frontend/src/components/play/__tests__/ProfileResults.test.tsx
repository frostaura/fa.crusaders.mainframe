import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderPage, signOut } from "@/test/harness";
import ProfileResultsPage from "@/pages/ProfileResults";
import { RESULTS_PAGE, RESULT_CARD, STATUS_WORD } from "@/lib/playCopy";
import { BOOKING, result, serve, STARTS } from "./playKit";

/** `/profile/results` (§6.2, §9.5): newest first, paged by the server's cursor, three states. */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const LIST = "/api/v1/me/play/results";
const row = (id: string, overrides = {}) => ({ ...result({ result_id: id, status: "confirmed", ...overrides }), court_name: "Court 1", starts_at: STARTS });

describe("my results", () => {
  it("lists each match with its place, status and the member's own outcome, then pages on", async () => {
    const stub = serve([
      { path: `${LIST}?limit=20`, body: { timezone: "Africa/Johannesburg", items: [row("r1")], next_cursor: "cur-2" } },
      { path: `${LIST}?cursor=cur-2`, body: { timezone: "Africa/Johannesburg", items: [row("r2", { status: "disputed" })], next_cursor: null } },
    ]);
    renderPage(<ProfileResultsPage />);
    const list = await waitFor(() => {
      const found = document.querySelector("[data-results]");
      expect(found?.children.length).toBe(1);
      return found as HTMLElement;
    });
    const first = list.children[0] as HTMLElement;
    expect(within(first).getByRole("link", { name: /Court 1 · Wed 30 Sep, 18:00/ })).toHaveAttribute("href", `/bookings/${BOOKING}`);
    expect(first).toHaveTextContent(STATUS_WORD.confirmed);
    expect(first).toHaveTextContent(`${RESULT_CARD.youWon} 3–1`);
    fireEvent.click(screen.getByRole("button", { name: RESULTS_PAGE.more }));
    await waitFor(() => expect(list.children).toHaveLength(2));
    expect(stub.calls.some((c) => c.path.includes("cursor=cur-2"))).toBe(true);
    expect(screen.queryByRole("button", { name: RESULTS_PAGE.more })).toBeNull();
  });

  it("says an empty history as empty, and a failed read as a failure", async () => {
    serve([{ path: LIST, body: { timezone: "Africa/Johannesburg", items: [], next_cursor: null } }]);
    renderPage(<ProfileResultsPage />);
    expect(await screen.findByText(RESULTS_PAGE.emptyTitle)).toBeInTheDocument();
  });

  it("a failed read has a retry and no empty state", async () => {
    serve([{ path: LIST, respond: () => { throw new TypeError("Failed to fetch"); } }]);
    renderPage(<ProfileResultsPage />);
    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(RESULTS_PAGE.emptyTitle)).toBeNull();
  });
});
