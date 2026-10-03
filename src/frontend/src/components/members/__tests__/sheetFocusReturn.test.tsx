import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminMembersPage from "@/pages/AdminMembers";
import { memberFixture, renderPage, signOut, stubFetch } from "@/test/harness";
import { ADJUST_SHEET } from "@/lib/deskMinutesCopy";
import { ASSIGN_COPY } from "@/lib/groupsCopy";
import { MEMBER_COPY } from "@/lib/memberDetailCopy";
import { ROW_ACTIONS } from "@/lib/membersCopy";
import { baseRoutes, detailFixture, renderMember, serve } from "@/pages/admin/member/__tests__/memberKit";

/**
 * Review round 6, X6-1 — a sheet opened from a ⋯ MENU gives focus back to that ⋯ when it closes.
 *
 * <p>
 * The dialog surface returns focus to whatever had it when the sheet opened, and falls back to
 * `<main>` when that element has gone. Opened from a menu, what had focus was the menu ITEM, which
 * is unmounted with the menu — so a keyboard user who pressed Escape on Adjust minutes, Sell
 * package or Change groups landed at the top of the page. `AdminRoleDialog` already took a
 * `returnFocus`; the three sheets now do too. A sheet opened from a button that is still there
 * (the table's Sell package) keeps going back to that button.
 * </p>
 *
 * <p>
 * <b>jsdom does not reproduce the loss</b> — its menu hands focus back to the trigger before the
 * sheet mounts — so these hold the wiring; the red-first proof is `e2e/admin-r6.spec.ts` in Chromium.
 * </p>
 */

vi.setConfig({ testTimeout: 20_000 });

const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  signOut();
});

function listRoutes() {
  return [
    { path: "/api/v1/admin/members/", body: [memberFixture()] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/member-groups", body: { groups: [] } },
    { path: "/api/v1/admin/ledger/", body: [] },
    { path: "/api/v1/admin/minutes/", body: { discount: null, packages: [] } },
  ];
}

async function fromRowMenu(item: string) {
  const more = await screen.findByRole("button", { name: ROW_ACTIONS.more("Ada Lovelace") });
  fireEvent.pointerDown(more, POINTER);
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  return more;
}

async function escapeFrom(dialog: HTMLElement) {
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
}

describe("X6-1 — the members list's ⋯", () => {
  it("gives focus back to the row's ⋯ when Adjust minutes closes", async () => {
    stubFetch(listRoutes());
    renderPage(<AdminMembersPage />);
    const more = await fromRowMenu(ROW_ACTIONS.adjust);
    await screen.findByLabelText(ADJUST_SHEET.amountLabel);
    await escapeFrom(screen.getByRole("dialog"));
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it("gives focus back to the row's ⋯ when Change groups closes", async () => {
    stubFetch(listRoutes());
    renderPage(<AdminMembersPage />);
    const more = await fromRowMenu(ASSIGN_COPY.change);
    const dialog = await screen.findByRole("dialog");
    await escapeFrom(dialog);
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it("still gives focus back to the table's own Sell package button, which is still there", async () => {
    stubFetch(listRoutes());
    renderPage(<AdminMembersPage />);
    const sell = await screen.findByRole("button", { name: ROW_ACTIONS.sell });
    sell.focus();
    fireEvent.click(sell);
    const dialog = await screen.findByRole("dialog");
    await escapeFrom(dialog);
    await waitFor(() => expect(document.activeElement).toBe(sell));
  });
});

describe("X6-1 — the record header's ⋯", () => {
  it("gives focus back to the header's ⋯ when Adjust minutes closes", async () => {
    serve([...baseRoutes(detailFixture()), { path: "/api/v1/admin/ledger/", body: [] }]);
    renderMember();
    const more = await screen.findByRole("button", { name: MEMBER_COPY.moreActions("Thandi Mokoena") });
    fireEvent.pointerDown(more, POINTER);
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: MEMBER_COPY.adjust }));
    await screen.findByLabelText(ADJUST_SHEET.amountLabel);
    await escapeFrom(screen.getByRole("dialog"));
    await waitFor(() => expect(document.activeElement).toBe(more));
  });
});
