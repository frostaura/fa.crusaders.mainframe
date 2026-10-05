import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { RecentGames } from "@/components/bookings/RecentGames";
import { UpcomingGames } from "@/components/bookings/UpcomingGames";
import { MEMBERS_PAGE, MEMBERS_PAGE_SIZE } from "@/lib/membersCopy";
import { RECENT, UPCOMING } from "@/lib/bookingsCopy";
import type { UpcomingGame } from "@/lib/bookingsApi";
import { memberFixture, renderPage, signIn, signOut, stubFetch } from "@/test/harness";

/**
 * R14 X14-1 — the behavioural proof behind each entry of `paged-focus-scan.test.ts`'s allow-list
 * that had none: a paging control NOT on `usePagedFocus` must still never drop focus to `<body>`.
 */

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

describe("allow-listed paging controls keep focus", () => {
  it("members: the last Show more focuses the first member it revealed", async () => {
    const members = Array.from({ length: MEMBERS_PAGE_SIZE + 1 }, (_, i) => memberFixture({
      user_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, full_name: `Member ${String(i).padStart(3, "0")}`, email: `m${i}@club.review.test`,
    }));
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/members/", body: members },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ]);
    renderPage(<AdminMembersPage />);
    const more = await screen.findByRole("button", { name: MEMBERS_PAGE.showMore(1) }, { timeout: 5000 });
    more.focus();
    fireEvent.click(more);
    await waitFor(() => expect(screen.queryByRole("button", { name: MEMBERS_PAGE.showMore(1) })).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(document.body);
    // The row the reveal drew first — in the list's own order — holds focus.
    const rows = [...document.querySelectorAll("[data-member-row], [data-picker-row]")];
    expect(rows).toHaveLength(MEMBERS_PAGE_SIZE + 1);
    expect((document.activeElement as HTMLElement).closest("[data-member-row], [data-picker-row]")).toBe(rows[MEMBERS_PAGE_SIZE]);
  }, 30_000);

  const game = (i: number): UpcomingGame & { result_status: "none"; can_record: false } => ({
    booking_id: `b${i}`, court_name: `Court ${i}`, starts_at: `2030-01-0${i}T10:00:00Z`, ends_at: `2030-01-0${i}T11:00:00Z`,
    role: "organiser", status: "Booked", players: [], my_share_minutes: 60, needs_action: false, result_status: "none", can_record: false,
  });

  it.each([
    ["recent games", "/api/v1/me/bookings/recent", RECENT, () => <RecentGames refreshKey={0} fallbackZone="UTC" />],
    ["upcoming games", "/api/v1/me/bookings/upcoming", UPCOMING, () => <UpcomingGames refreshKey={0} fallbackZone="UTC" />],
  ] as const)("%s: Show more keeps focus on the same button", async (_name, path, copy, ui) => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path, body: { timezone: "UTC", items: [1, 2, 3, 4, 5].map(game) } },
    ]);
    renderPage(ui());
    const button = await screen.findByRole("button", { name: copy.more(2) }, { timeout: 5000 });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: copy.less })).toBe(button);
    expect(document.activeElement).toBe(button);
  }, 30_000);
});
