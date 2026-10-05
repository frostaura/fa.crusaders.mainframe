import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { DoorHistoryCard } from "./DoorHistoryCard";
import { renderPage, stubFetch } from "../../test/harness";
import { HISTORY_SHOW_MORE } from "../../lib/memberDoorCopy";
import type { MemberDoorHistoryRow } from "../../lib/api";

/**
 * R13 X13-1 — "My door history"'s last "Show more" takes its button away; focus must land on the
 * first row that page drew, never `<body>`. A page whose rows all collapse into the last group
 * (R3-31) drew nothing new, so the last row takes focus instead.
 */

afterEach(() => vi.unstubAllGlobals());

const PATH = "/api/v1/me/door/history";

function scan(at: string, door: string): MemberDoorHistoryRow {
  return { at, delivered_at: null, door_name: door, released: true, reason: "accepted", offline: false };
}

const FIRST = [scan("2026-10-01T16:00:00Z", "Front door"), scan("2026-10-01T15:00:00Z", "Side door")];

describe("My door history — the last Show more", () => {
  it.each([
    ["the first row the page drew", [scan("2026-09-30T10:00:00Z", "Back door")], 2],
    ["the last row when the page only grew the last group", [scan("2026-10-01T15:00:10Z", "Side door")], 1],
  ])("focuses %s", async (_name, older, index) => {
    stubFetch([
      {
        path: PATH,
        respond: ({ path }) => path.includes("cursor=")
          ? { items: older, next_cursor: null, retention_days: 90 }
          : { items: FIRST, next_cursor: "CUR1", retention_days: 90 },
      },
    ]);
    renderPage(<DoorHistoryCard />);
    const button = await screen.findByRole("button", { name: HISTORY_SHOW_MORE }, { timeout: 3000 });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("button", { name: HISTORY_SHOW_MORE })).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    const rows = document.querySelectorAll("[data-door-history-row]");
    expect(document.activeElement).toBe(rows[index]);
  }, 30_000);
});
