import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { ACTIONS_COPY, MEMBER_COPY } from "@/lib/memberDetailCopy";
import { baseRoutes, detailFixture, renderMember, serve } from "./memberKit";

/**
 * Review round 2 (F3-3): an approval that COMMITTED and whose reply was lost read "Approval
 * failed." on the member's page. The stubs perform the approval (the next read says Active) and
 * then fail the reply, exactly as the lost reply did.
 */
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

async function approveFromMenu(name: string) {
  fireEvent.pointerDown(await screen.findByRole("button", { name: MEMBER_COPY.moreActions(name) }), POINTER);
  fireEvent.click(await screen.findByRole("menuitem", { name: ACTIONS_COPY.approve }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: ACTIONS_COPY.approveConfirm }));
}

describe("member detail — an approval whose reply was lost", () => {
  beforeEach(() => { signOut(); });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the member again and says they are approved", async () => {
    const pending = detailFixture({ status: "PendingApproval" });
    const name = pending.full_name ?? "";
    const routes = baseRoutes(pending).map((r) => (r.path.startsWith("/api/v1/admin/members/") && !r.method
      ? { ...r, body: undefined, sequence: [pending, detailFixture({ status: "Active" })] } : r));
    serve([
      ...routes,
      { method: "POST", path: `/api/v1/admin/members/${pending.membership_id}/approve`, status: 504, body: { error: "gateway_timeout" } },
    ]);
    renderMember();

    await approveFromMenu(name);

    expect(await screen.findByText(ACTIONS_COPY.approvedAfterLostReply(name))).toBeInTheDocument();
    expect(screen.queryByText(/couldn't approve|Approval failed/i)).not.toBeInTheDocument();
  });
});
