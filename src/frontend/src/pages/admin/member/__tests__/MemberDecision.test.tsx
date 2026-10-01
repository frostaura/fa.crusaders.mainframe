import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { ACTIONS_COPY, MEMBER_COPY } from "@/lib/memberDetailCopy";
import { baseRoutes, detailFixture, renderMember, serve } from "./memberKit";

const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

/**
 * R4 form factor (SPEC §3.8): an application's decision is on the record's header — Approve and
 * Reject as worded buttons beside the name, so the queue is cleared with ↓, Enter, Approve from
 * the list beside it — and no longer two menus deep in the ⋯.
 */
describe("member detail — the decision on an application", () => {
  beforeEach(() => { signOut(); });

  async function menuItems(name: string) {
    fireEvent.pointerDown(await screen.findByRole("button", { name: MEMBER_COPY.moreActions(name) }), POINTER);
    return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
  }

  it("puts Approve and Reject under a pending applicant's name, and not in the ⋯", async () => {
    const detail = detailFixture({ status: "PendingApproval" });
    serve(baseRoutes(detail));
    renderMember();
    await screen.findByTestId("member-balance");
    const header = screen.getByRole("heading", { level: 1 }).closest("[data-page-header]") as HTMLElement;
    // The row right after the header, before the summary card.
    const decision = header.nextElementSibling as HTMLElement;
    expect(decision).toHaveAttribute("data-member-decision");
    expect(within(decision).getByRole("button", { name: ACTIONS_COPY.approve })).toBeInTheDocument();
    expect(within(decision).getByRole("button", { name: ACTIONS_COPY.reject })).toBeInTheDocument();
    const items = await menuItems(detail.full_name ?? "");
    expect(items).not.toContain(ACTIONS_COPY.approve);
    expect(items).not.toContain(ACTIONS_COPY.reject);
  });

  it("asks for a reason before a rejection is sent, from the header", async () => {
    const detail = detailFixture({ status: "PendingApproval" });
    const stub = serve(baseRoutes(detail));
    renderMember();
    fireEvent.click(await screen.findByRole("button", { name: ACTIONS_COPY.reject }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: ACTIONS_COPY.rejectConfirm }));
    await waitFor(() => expect(within(dialog).getByRole("textbox")).toHaveFocus());
    expect(stub.calls.some((c) => c.method === "POST" && c.path.endsWith("/reject"))).toBe(false);
  });

  it("offers a turned-down applicant Approve only, and an active member neither", async () => {
    serve(baseRoutes(detailFixture({ status: "Rejected" })));
    const { unmount } = renderMember();
    expect(await screen.findByRole("button", { name: ACTIONS_COPY.approve })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ACTIONS_COPY.reject })).toBeNull();
    unmount();

    serve(baseRoutes(detailFixture()));
    renderMember();
    await screen.findByRole("button", { name: MEMBER_COPY.sell });
    expect(screen.queryByRole("button", { name: ACTIONS_COPY.approve })).toBeNull();
  });
});
