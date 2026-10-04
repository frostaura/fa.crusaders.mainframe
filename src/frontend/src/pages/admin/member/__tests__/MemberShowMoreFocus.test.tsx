import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { BOOKINGS_TAB_COPY, DOORS_TAB_COPY } from "@/lib/memberDetailCopy";
import { BASE, MEMBER_ID, baseRoutes, bookingRow, detailFixture, doorRow, doorsPage, renderMember, serve } from "./memberKit";

/**
 * R12 X12-2 — a member's Bookings and Doors lists: the last "Load more" takes its button away,
 * and focus lands on the first row that page brought, never on `<body>`.
 */

const at = (path: string) => `/admin/members/${MEMBER_ID}/${path}`;

async function pressLast(name: string) {
  const button = await screen.findByRole("button", { name }, { timeout: 3000 });
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByRole("button", { name })).toBeNull());
  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
}

describe("member detail — the last page keeps focus", () => {
  beforeEach(() => { signOut(); });

  it("Bookings: the first appended booking takes focus", async () => {
    serve(baseRoutes(detailFixture(), [
      {
        path: `${BASE}/bookings`,
        respond: ({ path }) => (path.includes("cursor=")
          ? { when: "upcoming", items: [bookingRow({ booking_id: "b2", court_name: "Court 3" })], next_cursor: null }
          : { when: "upcoming", items: [bookingRow()], next_cursor: "CUR1" }),
      },
    ]));
    renderMember(at("bookings"));
    await pressLast(BOOKINGS_TAB_COPY.loadMore);
    expect(document.activeElement).toBe(document.querySelector('[data-booking-id="b2"]'));
  }, 40_000);

  it("Doors: the first older scan takes focus", async () => {
    serve(baseRoutes(detailFixture(), [
      { path: "/api/v1/admin/doors", body: { day_started_at: "2026-09-23T00:00:00+02:00", timezone: "Africa/Johannesburg", shut_all_active: false, doors: [] } },
      {
        path: `${BASE}/doors`,
        respond: ({ path }) => (path.includes("cursor=")
          ? doorsPage([doorRow({ at: "2026-09-20T09:00:00Z", reason_text: "An older scan" })], { total: 2 })
          : doorsPage([doorRow()], { next_cursor: "CUR1", total: 2 })),
      },
    ]));
    renderMember(at("doors"));
    await pressLast(DOORS_TAB_COPY.loadOlder);
    const focused = document.activeElement;
    expect(focused?.tagName).toBe("LI");
    expect(focused).toHaveTextContent("An older scan");
  }, 40_000);
});
