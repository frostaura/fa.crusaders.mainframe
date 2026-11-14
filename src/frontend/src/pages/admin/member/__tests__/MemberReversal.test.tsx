import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { MEMBER_COPY } from "@/lib/memberDetailCopy";
import { REVERSAL_COPY } from "@/lib/reversalCopy";
import { MEMBER_ID, baseRoutes, detailFixture, renderMember, serve } from "./memberKit";

/**
 * BM-6: the desk records money given back from the member's own ⋯ — for anybody with a membership,
 * because a suspended member's refund still takes rand out of the club's revenue.
 */
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;
const LIST = `/api/v1/admin/minutes/${MEMBER_ID}/reversible`;

async function openMenu() {
  fireEvent.pointerDown(await screen.findByRole("button", { name: MEMBER_COPY.moreActions("Thandi Mokoena") }), POINTER);
}

describe("member detail — refund or chargeback", () => {
  beforeEach(() => { signOut(); });

  it.each(["Active", "Suspended"] as const)("is in the ⋯ of a %s member and opens the sheet on their purchases", async (status) => {
    const stub = serve(baseRoutes(detailFixture({ status }), [{ path: LIST, body: { entries: [] } }]));
    renderMember();
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: REVERSAL_COPY.menu }));
    expect(await screen.findByRole("dialog", { name: REVERSAL_COPY.titleFor("Thandi Mokoena") })).toBeInTheDocument();
    expect(await screen.findByText(REVERSAL_COPY.emptyTitle)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path === LIST)).toBe(true);
  });

  it("is not offered for an account with no membership", async () => {
    serve(baseRoutes(detailFixture({ status: null, membership_id: null })));
    renderMember();
    await openMenu();
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: REVERSAL_COPY.menu })).not.toBeInTheDocument();
  });
});
