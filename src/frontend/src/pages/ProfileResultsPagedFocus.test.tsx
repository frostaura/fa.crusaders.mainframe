import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderPage, signOut } from "@/test/harness";
import ProfileResultsPage from "@/pages/ProfileResults";
import { RESULTS_PAGE } from "@/lib/playCopy";
import { result, serve, STARTS } from "@/components/play/__tests__/playKit";

/**
 * R13 X13-1 — "My results"' last "Show more" takes its button away; focus must land on the link of
 * the first result that page brought, never `<body>`. One older result and two.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const LIST = "/api/v1/me/play/results";
const row = (id: string) => ({ ...result({ result_id: id, booking_id: `b-${id}`, status: "confirmed" }), court_name: "Court 1", starts_at: STARTS });

describe("my results — the last Show more", () => {
  it.each([
    ["one older result", [row("r2")]],
    ["two older results", [row("r2"), row("r3")]],
  ])("focuses the first result's link with %s", async (_name, older) => {
    serve([
      { path: `${LIST}?limit=20`, body: { timezone: "Africa/Johannesburg", items: [row("r1")], next_cursor: "cur-2" } },
      { path: `${LIST}?cursor=cur-2`, body: { timezone: "Africa/Johannesburg", items: older, next_cursor: null } },
    ]);
    renderPage(<ProfileResultsPage />);
    const button = await screen.findByRole("button", { name: RESULTS_PAGE.more }, { timeout: 3000 });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("button", { name: RESULTS_PAGE.more })).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.tagName).toBe("A");
    expect(document.activeElement).toHaveAttribute("href", "/bookings/b-r2");
  }, 30_000);
});
