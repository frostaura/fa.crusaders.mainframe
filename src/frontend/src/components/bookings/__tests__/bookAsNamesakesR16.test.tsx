import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { BOOK_SHEET } from "@/lib/bookingsCopy";
import { DETAIL_ADMIN } from "@/lib/playersCopy";
import { BookSheet } from "../BookSheet";
import type { SelectedSlot } from "../types";

/**
 * R16 J16-3 class sweep — the desk's "Book as" member combobox mapped members as name, photo and
 * balance: two members called "Pia van Partner" read alike, and the desk could book the wrong one.
 * Each row now carries the membership number and email, as the club's other comboboxes do, and
 * the search matches on them.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

const SLOT: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 3, priceMinutes: 50 };
const member = (id: string, name: string, number: string, email: string) => ({
  membership_id: `m-${id}`, user_id: id, email, full_name: name, membership_number: number, photo_url: null,
  status: "Active", created_at: "2024-01-01T00:00:00Z", rejection_reason: null, balance_minutes: 40,
});

async function openPicker(rows: unknown[]) {
  signIn({ isAdmin: true });
  stubFetch([{ path: "/api/v1/admin/members", body: rows }]);
  renderPage(
    <BookSheet open onOpenChange={() => {}} slots={[SLOT]} timezone="Africa/Johannesburg" sliceMinutes={15}
      isAdmin actorUserId="desk-admin" balanceMinutes={0} />,
  );
  fireEvent.click(await screen.findByRole("radio", { name: BOOK_SHEET.asMember }));
  const combo = await screen.findByRole("combobox", { name: new RegExp(`^${BOOK_SHEET.memberLabel}`) });
  const user = userEvent.setup();
  await user.click(combo);
  return user;
}

describe("R16 J16-3 — the desk's Book-as combobox tells namesakes apart", () => {
  it("two namesakes: each row carries its membership number and email", async () => {
    await openPicker([
      member("pia-a", "Pia van Partner", "1042", "pia@review.test"),
      member("pia-b", "Pia van Partner", "2210", "pia.vp@review.test"),
    ]);
    expect(await screen.findByText(DETAIL_ADMIN.memberSubtitle("1042", "pia@review.test"))).toBeInTheDocument();
    expect(screen.getByText(DETAIL_ADMIN.memberSubtitle("2210", "pia.vp@review.test"))).toBeInTheDocument();
    expect(screen.getByText("#1042 · pia@review.test")).toBeInTheDocument();
  });

  it("the search finds one namesake by her membership number, and the picked one keeps her line", async () => {
    const user = await openPicker([
      member("pia-a", "Pia van Partner", "1042", "pia@review.test"),
      member("pia-b", "Pia van Partner", "2210", "pia.vp@review.test"),
    ]);
    await user.keyboard("2210");
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);
    await user.click(within(listbox).getByRole("option"));
    const combo = screen.getByRole("combobox", { name: new RegExp(`^${BOOK_SHEET.memberLabel}`) });
    expect(combo).toHaveTextContent("#2210 · pia.vp@review.test");
  });

  it("a member with no membership number is told apart by her email alone", async () => {
    await openPicker([
      member("pia-a", "Pia van Partner", "", "pia@review.test"),
      member("pia-b", "Pia van Partner", "2210", "pia.vp@review.test"),
    ]);
    expect(await screen.findByText("pia@review.test")).toBeInTheDocument();
    expect(screen.getByText("#2210 · pia.vp@review.test")).toBeInTheDocument();
  });
});
