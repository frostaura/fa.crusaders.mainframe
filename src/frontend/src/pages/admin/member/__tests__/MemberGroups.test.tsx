import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import type { MemberDetail } from "@/lib/memberDetailApi";
import { ASSIGN_COPY } from "@/lib/groupsCopy";
import { BASE, MEMBER_ID, baseRoutes, detailFixture, renderMember, serve } from "./memberKit";

/**
 * The member's groups on their own page (P6, D2): the header's chips became editable through
 * GroupAssign, and the rate and peak standing they add up to are said under them — because since
 * D2 a person's groups ARE their top-up rate and their peak hours.
 */
describe("member detail — groups in the header", () => {
  beforeEach(() => { signOut(); });

  const LEAGUE = { id: "g-league", name: "League", status: "active", system_key: "league", credits_per_zar: 2.4, peak_priority: true };
  const JUNIORS = { id: "g-juniors", name: "Juniors", status: "active", system_key: null, credits_per_zar: null, peak_priority: false };
  const withTariff = (overrides: Record<string, unknown> = {}) => detailFixture({
    groups: [{ id: "g-league", name: "League", system_key: "league" }],
    tariff: { top_up_credits_per_zar: 2.4, rate_group_id: "g-league", peak_priority: true, peak_withheld_by: [] },
    ...overrides,
  } as unknown as Partial<MemberDetail>);

  it("says the rate and peak standing their groups add up to", async () => {
    serve(baseRoutes(withTariff()));
    renderMember();
    expect(await screen.findByTestId("member-tariff")).toHaveTextContent("Tops up at 2.4 cr per R1 (League) · peak priority");
  });

  it("changes their groups from the header, and the header takes the saved set", async () => {
    const saved = { top_up_credits_per_zar: 2.4, rate_group_id: "g-league", peak_priority: false, peak_withheld_by: ["Juniors"] };
    // The detail is read twice: on arrival, and again after the save (the header re-reads).
    const after = withTariff({ groups: [LEAGUE, JUNIORS], tariff: saved });
    const stub = serve([
      ...baseRoutes(withTariff()).filter((r) => r.path !== BASE),
      { path: BASE, body: null, sequence: [withTariff(), after, after] },
      { path: "/api/v1/admin/member-groups", body: { groups: [LEAGUE, JUNIORS] } },
      {
        method: "POST",
        path: "/api/v1/admin/member-groups/preview",
        body: {
          current: { tariff: { top_up_credits_per_zar: 2.4, rate_group_id: "g-league", peak_priority: true, peak_withheld_by: [] } },
          would_be: { tariff: saved },
        },
      },
      {
        method: "PUT",
        path: `${BASE}/groups`,
        body: { user_id: MEMBER_ID, groups: [LEAGUE, JUNIORS], added: ["g-juniors"], removed: [], tariff: saved },
      },
    ]);
    renderMember();

    fireEvent.click(await screen.findByRole("button", { name: ASSIGN_COPY.changeFor("Thandi Mokoena") }));
    const dialog = await screen.findByRole("dialog", { name: ASSIGN_COPY.title("Thandi Mokoena") });
    fireEvent.click(await within(dialog).findByRole("combobox", { name: /Add a group/ }));
    const option = await screen.findByRole("option", { name: /Juniors/ });
    fireEvent.click(option);
    fireEvent.keyDown(option, { key: "Escape" });

    // The loss is said before the save, naming the group that causes it.
    expect(await within(dialog).findByText("Loses peak priority — Juniors withholds it.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: ASSIGN_COPY.saveLabel("Thandi", 2) }));

    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT")?.body).toEqual({ groupIds: ["g-league", "g-juniors"] }));
    await waitFor(() => expect(screen.getByRole("list", { name: "Groups" })).toHaveTextContent("Juniors"));
    expect(screen.getByTestId("member-tariff")).toHaveTextContent("no peak priority (withheld by Juniors)");
  });
});
