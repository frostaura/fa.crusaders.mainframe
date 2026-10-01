import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { MembersTable } from "../MembersTable";
import type { RowActionHandlers } from "../RowActions";
import type { MemberRow } from "../membersModel";
import { COLUMNS, ROW_ACTIONS } from "../../../lib/membersCopy";
import { renderPage } from "../../../test/harness";

/**
 * Review round 5 — §4.3: a phone card draws its Top up in the ⋯ (jsdom has no ResizeObserver, so
 * the table's box reads narrow: the card's shape); V-14: no Groups column where nobody has a group.
 */
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

function row(i: number, groups: { id: string; name: string }[] = []): MemberRow {
  return {
    user_id: `u-${i}`, membership_id: `m-${i}`, full_name: `Member ${i}`, email: `m${i}@x.test`,
    membership_number: `MEM-${i}`, status: "Active", email_verified: true, balance_minutes: 10,
    created_at: "2026-09-01T08:00:00Z", photo_url: null, is_admin: false, admin_source: null, groups,
  } as unknown as MemberRow;
}

function handlers(): RowActionHandlers {
  return {
    approve: vi.fn(), reject: vi.fn(), topUp: vi.fn(), fingerprints: vi.fn(), reset: vi.fn(), resetCode: vi.fn(),
    resend: vi.fn(), changeGroups: vi.fn(), suspend: vi.fn(), reactivate: vi.fn(), adminRole: vi.fn(), fingerprintCount: () => 0,
  };
}

function draw(rows: MemberRow[], h = handlers()) {
  renderPage(
    <MembersTable rows={rows} groupsOf={(r) => r.groups ?? []} dateColumn="joined"
      sort={{ key: "full_name", dir: "asc" }} onSort={() => {}} now={0} handlers={h} />,
  );
  return h;
}

describe("the members table, round 5", () => {
  it("offers Top up from the ⋯ on a card (§4.3)", async () => {
    const h = draw([row(1)]);
    fireEvent.pointerDown(screen.getByRole("button", { name: ROW_ACTIONS.more("Member 1") }), POINTER);
    fireEvent.click(await screen.findByRole("menuitem", { name: ROW_ACTIONS.topUp }));
    expect(h.topUp).toHaveBeenCalledWith(expect.objectContaining({ user_id: "u-1" }));
  });

  it("draws no Groups column when nobody on the page is in a group, and one when somebody is (V-14)", () => {
    const first = renderPage(
      <MembersTable rows={[row(1), row(2)]} groupsOf={(r) => r.groups ?? []} dateColumn="joined"
        sort={{ key: "full_name", dir: "asc" }} onSort={() => {}} now={0} handlers={handlers()} />,
    );
    expect(screen.queryByRole("columnheader", { name: COLUMNS.groups })).not.toBeInTheDocument();
    first.unmount();
    draw([row(1), row(2, [{ id: "g", name: "League" }])]);
    expect(screen.getByRole("columnheader", { name: COLUMNS.groups })).toBeInTheDocument();
  });
});
