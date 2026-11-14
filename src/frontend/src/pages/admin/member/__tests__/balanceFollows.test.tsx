import { describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { waitFor } from "@testing-library/react";
import { renderPage } from "@/test/harness";
import { MembersSplitContext } from "@/components/members/membersSplit";
import MemberDetailLayout from "../MemberDetailLayout";
import { MemberOverview } from "../MemberOverview";
import { MEMBER_ID, baseRoutes, detailFixture, serve } from "./memberKit";

/**
 * BA-07: after a desk cancel or an adjustment the record's header moved and the list row beside it
 * kept the old balance. The record hands every balance it shows to the split view, which patches
 * the list row to the same figure.
 */
describe("the list row follows the record's balance", () => {
  it("hands the balance the record shows to the list beside it", async () => {
    serve(baseRoutes(detailFixture({ balance_minutes: 75 })));
    const onMemberBalance = vi.fn();
    renderPage(
      <MembersSplitContext.Provider value={{ listHref: "/admin/members", onMemberBalance }}>
        <Routes>
          <Route path="/admin/members/:userId" element={<MemberDetailLayout />}>
            <Route index element={<MemberOverview />} />
          </Route>
        </Routes>
      </MembersSplitContext.Provider>,
      { initialEntries: [`/admin/members/${MEMBER_ID}`] },
    );
    await waitFor(() => expect(onMemberBalance).toHaveBeenCalledWith(MEMBER_ID, 75));
  });
});
