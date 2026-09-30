import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { refuse, signOut } from "@/test/harness";
import type { MemberDetail } from "@/lib/memberDetailApi";
import { ASSIGN_COPY, ASSIGN_LOST } from "@/lib/groupsCopy";
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
          current: {
            tariff: { top_up_credits_per_zar: 2.4, rate_group_id: "g-league", peak_priority: true, peak_withheld_by: [] },
            allowed_windows: [{ start: "06:00", end: "22:00" }], max_slots_per_day: 4, advance_booking_days: 14,
          },
          would_be: {
            tariff: saved,
            allowed_windows: [{ start: "14:00", end: "18:00" }], max_slots_per_day: 2, advance_booking_days: 14,
          },
        },
      },
      {
        method: "PUT",
        path: `${BASE}/groups`,
        body: { user_id: MEMBER_ID, groups: [LEAGUE, JUNIORS], added: ["g-juniors"], removed: [], tariff: saved },
      },
    ]);
    renderMember();

    const change = await screen.findByRole("button", { name: ASSIGN_COPY.changeFor("Thandi Mokoena") });
    // 44 × 44 at the least (review round 2, A11Y F3-19: it measured 42 × 36 at 390).
    expect(change.className).toMatch(/min-h-touch/);
    expect(change.className).toMatch(/min-w-touch/);
    fireEvent.click(change);
    const dialog = await screen.findByRole("dialog", { name: ASSIGN_COPY.title("Thandi Mokoena") });
    fireEvent.click(await within(dialog).findByRole("combobox", { name: /Add a group/ }));
    const option = await screen.findByRole("option", { name: /Juniors/ });
    fireEvent.click(option);
    fireEvent.keyDown(option, { key: "Escape" });

    // The loss is said before the save, naming the group that causes it.
    expect(await within(dialog).findByText("Loses peak priority — Juniors withholds it.")).toBeInTheDocument();
    // F3.12: the booking times and the daily limit move too, and the preview says so.
    expect(within(dialog).getByText("Today they could book 14:00–18:00 instead of 06:00–22:00.")).toBeInTheDocument();
    expect(within(dialog).getByText("Slots a day: 2 slots instead of 4 slots.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Booking ahead/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: ASSIGN_COPY.saveLabel("Thandi", 2) }));

    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT")?.body).toEqual({ groupIds: ["g-league", "g-juniors"] }));
    await waitFor(() => expect(screen.getByRole("list", { name: "Groups" })).toHaveTextContent("Juniors"));
    expect(screen.getByTestId("member-tariff")).toHaveTextContent("no peak priority (withheld by Juniors)");
  });
});

/**
 * R4 carry-over: a member's groups saved from their page, the reply lost. The stub performs the
 * save, then fails the reply; the member is read back.
 */
describe("member detail — a groups save whose reply was lost", () => {
  beforeEach(() => { signOut(); });

  const LEAGUE = { id: "g-league", name: "League", status: "active", system_key: "league", credits_per_zar: 2.4, peak_priority: true };
  const JUNIORS = { id: "g-juniors", name: "Juniors", status: "active", system_key: null, credits_per_zar: null, peak_priority: false };
  const TARIFF = { top_up_credits_per_zar: 2.4, rate_group_id: "g-league", peak_priority: true, peak_withheld_by: [] };

  function lost(landed: boolean, readable = true) {
    let groups: Array<Record<string, unknown>> = [{ id: "g-league", name: "League", system_key: "league" }];
    let reads = 0;
    return serve([
      ...baseRoutes(detailFixture({ groups, tariff: TARIFF } as unknown as Partial<MemberDetail>)).filter((r) => r.path !== BASE),
      {
        path: BASE,
        respond: () => (++reads > 1 && !readable
          ? refuse(503, { error: "down" })
          : detailFixture({ groups, tariff: TARIFF } as unknown as Partial<MemberDetail>)),
      },
      { path: "/api/v1/admin/member-groups", body: { groups: [LEAGUE, JUNIORS] } },
      { method: "POST", path: "/api/v1/admin/member-groups/preview", status: 503, body: { error: "down" } },
      {
        method: "PUT", path: `${BASE}/groups`,
        respond: () => {
          if (landed) groups = [LEAGUE, JUNIORS];
          return refuse(504, { error: "gateway_timeout" });
        },
      },
    ]);
  }

  async function addJuniors() {
    fireEvent.click(await screen.findByRole("button", { name: ASSIGN_COPY.changeFor("Thandi Mokoena") }));
    const dialog = await screen.findByRole("dialog", { name: ASSIGN_COPY.title("Thandi Mokoena") });
    fireEvent.click(await within(dialog).findByRole("combobox", { name: /Add a group/ }));
    const option = await screen.findByRole("option", { name: /Juniors/ });
    fireEvent.click(option);
    fireEvent.keyDown(option, { key: "Escape" });
    fireEvent.click(within(dialog).getByRole("button", { name: ASSIGN_COPY.saveLabel("Thandi", 2) }));
    return dialog;
  }

  it("says it saved, with the reply-lost note, when the member now has the set sent", async () => {
    lost(true);
    renderMember();
    await addJuniors();
    expect(await screen.findByText(/The club's reply didn't arrive, so we checked its record\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("says nothing changed, in the sheet, when the member's groups are as they were", async () => {
    lost(false);
    renderMember();
    const dialog = await addJuniors();
    expect(await within(dialog).findByText(ASSIGN_LOST.checked)).toBeInTheDocument();
  });

  it("says it cannot tell when the member cannot be read either", async () => {
    lost(true, false);
    renderMember();
    const dialog = await addJuniors();
    expect(await within(dialog).findByText(ASSIGN_LOST.unchecked)).toBeInTheDocument();
  });
});
