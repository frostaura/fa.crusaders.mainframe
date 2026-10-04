import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderPage, signOut } from "@/test/harness";
import AdminResultsPage from "@/pages/admin/AdminResults";
import { ADMIN_RESULTS } from "@/lib/playCopy";
import { adminResult, serve, RESULT_ID } from "@/components/play/__tests__/playKit";

/**
 * R12 X12-2 — Match results' last "Show more" takes its button away; the first result that page
 * brought takes focus, never `<body>`.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const LIST = "/api/v1/admin/play/results";

describe("Match results — the last Show more", () => {
  it("focuses the first result the page brought", async () => {
    serve([
      {
        path: `${LIST}?status=disputed`,
        respond: ({ path }) => (path.includes("cursor=")
          ? { items: [adminResult({ result_id: "r-older" })], next_cursor: null, count: 2 }
          : { items: [adminResult()], next_cursor: "CUR1", count: 2 }),
      },
      { path: `${LIST}/disputed/count`, body: { count: 2 } },
    ], { admin: true });
    renderPage(<AdminResultsPage />);
    const button = await screen.findByRole("button", { name: ADMIN_RESULTS.more }, { timeout: 3000 });
    expect(document.querySelector(`[data-admin-result="${RESULT_ID}"]`)).not.toBeNull();
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("button", { name: ADMIN_RESULTS.more })).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toBe(document.querySelector('[data-admin-result="r-older"]'));
  }, 40_000);
});
