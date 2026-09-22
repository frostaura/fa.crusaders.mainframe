import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AdminGroupsPage } from "./AdminGroups";
import { SETTINGS_FIXTURE, memberFixture, renderPage, signIn, stubFetch, type StubRoute } from "../test/harness";
import {
  bookingRulesFixture, groupFixture, groupMemberFixture, restrictedGroupFixture, weekdayWindows,
} from "../test/groupFixtures";
import type { MemberGroup } from "../lib/adminApi";

/**
 * Member groups — GOAL items 3 and 19, the admin half.
 *
 * <p>
 * <b>Three properties carry this page, and all three are about refusing to claim something.</b>
 * It must never render an empty list of groups over a read that failed, because "the club has
 * no groups" and "we could not ask" are different answers. It must never show a preview whose
 * intersection is empty as an empty grid, because an empty grid reads as "the club is shut" and
 * sends an admin to the opening hours to look for a fault that is in the groups. And it must
 * never report a cap override that cannot bite as saved, because a save that says it worked and
 * changes nothing is a defect nobody ever finds.
 * </p>
 *
 * <p>
 * <b>Deleting is refused rather than cascaded, and the refusal carries its own escape.</b> A
 * cascade silently changes what every member of that group may book and what they pay, with no
 * screen showing it — so the page renders the two 409s as sentences and names archiving.
 * </p>
 */

/**
 * The club, WITH the per-day slot ceiling ruling 3 adds.
 *
 * <p>
 * `SETTINGS_FIXTURE` deliberately does not carry `member_max_slots_per_day` — three backend
 * lanes are shipping these keys in parallel with this screen, so absent is a real state and the
 * shared fixture describes the club as it is today. A test about what the ceiling SAYS has to
 * supply one; the absent arm has its own case below, because "the club has no slot limit" and
 * "the club's system has not told us" are different sentences.
 * </p>
 */
const CLUB = { ...SETTINGS_FIXTURE, member_max_slots_per_day: 4 };

/*
 * `settingsRoute` is a PARAMETER rather than something a caller adds to `extra`, and that is the
 * stub's own rule showing through: it sorts by path length and two routes with the same path
 * tie, so the first declared wins and an override appended later never fires at all — a test
 * that silently exercises the default club and proves nothing.
 */
const ROUTES = (
  groups: MemberGroup[] | null,
  extra: StubRoute[] = [],
  settingsRoute: StubRoute = { path: "/api/v1/admin/settings/", body: CLUB },
): StubRoute[] => [
  { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
  settingsRoute,
  { path: "/api/v1/admin/members/", body: [memberFixture(), memberFixture({ user_id: "u2", full_name: "Thandi Nkosi", membership_number: "CR-0002" })] },
  ...(groups ? [{ path: "/api/v1/admin/member-groups", body: { groups } } as StubRoute] : []),
  ...extra,
];

const OFF_PEAK = restrictedGroupFixture({
  id: "g-offpeak", name: "Off-peak", member_count: 37,
  windows: weekdayWindows(["mon", "tue", "wed", "thu", "fri"], "06:00", "16:00"),
});

function open(groups: MemberGroup[] | null, extra: StubRoute[] = [], settingsRoute?: StubRoute) {
  const stub = stubFetch(ROUTES(groups, extra, settingsRoute));
  renderPage(<AdminGroupsPage />);
  return stub;
}

describe("the standing statement and the three honest reads", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  it("says the rule above everything, once", async () => {
    open([groupFixture()]);
    // Twice in the DOM on purpose: the visible banner and the region that speaks it once.
    expect((await screen.findAllByText(/the strictest one wins/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/club-wide limits/).length).toBeGreaterThan(0);
  });

  /** The trap this whole release is written against. */
  it("never says the club has no groups when what happened is that it could not ask", async () => {
    open(null, [{ path: "/api/v1/admin/member-groups", status: 500, body: { error: "boom" } }]);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't read the club's groups/);
    expect(screen.queryByText(/No groups yet/), "an empty state over a failed read").not.toBeInTheDocument();
  });

  /**
   * <b>A failed RE-read is a fact about the request, not about the club.</b> The rows on screen
   * are still the last thing the club actually said, and throwing them away because a refresh
   * after a save did not come back leaves an admin with nothing — while showing them with no
   * qualifier at all would be the page claiming they are current. Both halves: the rows stay,
   * and a banner says they are not being updated.
   */
  it("keeps the groups it already has when a re-read fails, and says they are not current", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/settings/", body: CLUB },
      { path: "/api/v1/admin/members/", body: [memberFixture()] },
      { path: "/api/v1/admin/member-groups", body: null, sequence: [{ groups: [OFF_PEAK] }, { error: "boom" }], status: [200, 500] },
      { method: "PATCH", path: "/api/v1/admin/member-groups/g-offpeak", body: { ...OFF_PEAK, status: "archived" } },
    ]);
    renderPage(<AdminGroupsPage />);
    await screen.findByRole("heading", { name: "Off-peak" });

    fireEvent.click(screen.getByRole("button", { name: /Archive this group — Off-peak/ }));
    fireEvent.click(await screen.findByRole("button", { name: /choose again to confirm/ }));

    expect(await screen.findByText(/Couldn't read the club's groups\. Nothing has changed\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Off-peak" }), "the rows the club last gave us")
      .toBeInTheDocument();
  });

  it("handles the empty the seed makes impossible, and says what it means", async () => {
    open([]);
    expect(await screen.findByText(/No groups yet\. Everyone can book any open slot/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create a group/ })).toBeInTheDocument();
  });

  it("shows each group with what it costs and when it applies, in one line each", async () => {
    open([OFF_PEAK]);
    expect(await screen.findByRole("heading", { name: "Off-peak" })).toBeInTheDocument();
    expect(screen.getByText("37 members")).toBeInTheDocument();
    expect(screen.getByText(/Mondays to Fridays 06:00–16:00/)).toBeInTheDocument();
    expect(screen.getByText(/One slot costs what the court costs — 8 credits/)).toBeInTheDocument();
  });

  it("says what a top-up block buys, because “1.6” means nothing to a volunteer", async () => {
    open([groupFixture()]);
    expect(await screen.findByText(/R100\.00 buys 160 credits/)).toBeInTheDocument();
  });
});

describe("the editor", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  const edit = async (groups: MemberGroup[], extra: StubRoute[] = []) => {
    const stub = open(groups, extra);
    fireEvent.click(await screen.findByRole("button", { name: /Edit Off-peak/ }));
    return stub;
  };

  it("shows what one slot will cost under the choice being made, as it is made", async () => {
    await edit([OFF_PEAK]);
    fireEvent.click(await screen.findByRole("radio", { name: /A multiple of the court's price/ }));
    fireEvent.change(screen.getByLabelText(/Multiplier/), { target: { value: "0.75" } });
    // Three radio buttons with no figure beside them are three buttons an admin guesses at.
    expect(await screen.findByText(/One slot costs 6 credits — 0.75× the court's 8/)).toBeInTheDocument();
  });

  it("keeps each cap behind “use the club's limit”, and says what the club's is", async () => {
    await edit([OFF_PEAK]);
    const box = await screen.findByRole("checkbox", { name: /Use the club's limit for slots a day/ });
    expect(box).toBeChecked();
    expect(screen.getByText(/Off-peak members get the club's limit of 4 slots a day/)).toBeInTheDocument();
    expect(screen.getByText(/Admins are never limited/)).toBeInTheDocument();
  });

  /**
   * <b>Ruling 3.</b> A group may lower a cap and never raise one, so an override at or above
   * the club's own bound is inert — and without this the admin types 8, is told it saved, and
   * never learns why the member still gets 4.
   */
  it("refuses to let an override that cannot bite look like it saved", async () => {
    await edit([OFF_PEAK]);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Use the club's limit for slots a day/ }));
    fireEvent.change(screen.getByLabelText(/Slots a day for this group/), { target: { value: "8" } });
    expect(await screen.findByText(/A group can lower that and never raise it, so 8 would change nothing/))
      .toBeInTheDocument();
  });

  /**
   * The same rule one screen out: `SETTINGS_FIXTURE` is the club as it is TODAY, with the
   * per-day slot key not yet shipped, and the editor has to say so rather than reporting a club
   * that has chosen to limit nobody.
   */
  it("will not say the club has no slot limit when the key simply has not shipped", async () => {
    const stub = stubFetch(ROUTES([OFF_PEAK], [], { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE }));
    renderPage(<AdminGroupsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit Off-peak/ }));
    expect(await screen.findByText(/The club's system hasn't said a limit on slots a day/)).toBeInTheDocument();
    expect(screen.queryByText(/have no limit on how many slots they book in a day/)).not.toBeInTheDocument();
    expect(stub.calls.some((c) => c.path.includes("/admin/settings/"))).toBe(true);
  });

  it("sends the windows whole, and a cap left inheriting as null", async () => {
    const stub = await edit([OFF_PEAK], [
      { method: "PATCH", path: "/api/v1/admin/member-groups/g-offpeak", body: OFF_PEAK },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: /Save Off-peak/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = stub.calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    // Windows replace wholesale on the wire, so a PATCH that sent a subset would silently drop
    // the days it left out.
    expect(sent.windows).toHaveLength(5);
    expect((sent.caps as Record<string, unknown>).maxSlotsPerDay).toBeNull();
  });

  it("renders a refusal as a sentence that names the day, never as a code", async () => {
    const stub = await edit([OFF_PEAK], [{
      method: "PATCH",
      path: "/api/v1/admin/member-groups/g-offpeak",
      status: 400,
      body: { error: "group_windows_overlap", day: "sat" },
    }]);
    fireEvent.click(await screen.findByRole("button", { name: /Save Off-peak/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Saturday/);
    expect(alert).not.toHaveTextContent(/group_windows_overlap/);
    expect(stub.calls.some((c) => c.method === "PATCH")).toBe(true);
  });
});

describe("deleting, which is refused rather than cascaded", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  it("explains a refused delete in members, and offers archiving in the same breath", async () => {
    open([OFF_PEAK], [{
      method: "DELETE",
      path: "/api/v1/admin/member-groups/g-offpeak",
      status: 409,
      body: { error: "group_has_members", member_count: 37 },
    }]);
    fireEvent.click(await screen.findByRole("button", { name: /Delete this group — Off-peak/ }));
    fireEvent.click(await screen.findByRole("button", { name: /choose again to confirm/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/37 members/);
    expect(alert).toHaveTextContent(/Archive it instead/);
    expect(alert).not.toHaveTextContent(/group_has_members/);
  });

  /**
   * The two seeded groups are renameable and editable and never deletable, so the control is
   * ABSENT rather than disabled — and the reason is on screen, because a control that is simply
   * missing is indistinguishable from one somebody forgot to build.
   */
  it("offers no delete at all on one of the club's two standing groups", async () => {
    open([groupFixture({ name: "Regular", is_system_default: true })]);
    await screen.findByRole("heading", { name: "Regular" });
    expect(screen.queryByRole("button", { name: /Delete this group/ })).not.toBeInTheDocument();
    expect(screen.getByText(/one of the club's two standing groups/)).toBeInTheDocument();
  });

  it("archives with a PATCH, which is the reversible escape the refusal names", async () => {
    const stub = open([OFF_PEAK], [{
      method: "PATCH",
      path: "/api/v1/admin/member-groups/g-offpeak",
      body: { ...OFF_PEAK, status: "archived" },
    }]);
    fireEvent.click(await screen.findByRole("button", { name: /Archive this group — Off-peak/ }));
    fireEvent.click(await screen.findByRole("button", { name: /choose again to confirm/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(stub.calls.find((c) => c.method === "PATCH")!.body).toEqual({ status: "archived" });
  });
});

describe("assigning members from the group", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  // Somebody who is NOT in the club-members fixture's two, so both of those are still
  // addable: a candidate list that silently excluded them would make every count below wrong.
  const membersRoute = {
    path: "/api/v1/admin/member-groups/g-offpeak/members",
    body: {
      members: [groupMemberFixture({ user_id: "u9", name: "Sipho Dlamini", membership_number: "CR-0009" })],
      total: 1,
      cursor: null,
    },
  };

  it("labels the action with the number and the group, never “Add selected”", async () => {
    open([OFF_PEAK], [membersRoute]);
    fireEvent.click(await screen.findByRole("button", { name: /Members of Off-peak/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Thandi Nkosi/ }));
    expect(await screen.findByRole("button", { name: "Add 1 member to Off-peak" })).toBeInTheDocument();
  });

  /**
   * <b>A batch answers per item, so the screen shows per item.</b> Four seconds of toast is not
   * long enough to read six outcomes, the toast viewport deliberately carries no live region,
   * and "already in this group" is not a failure — which a success/failure count cannot say.
   */
  it("reports the result as a screen with one row per person, never as a toast", async () => {
    open([OFF_PEAK], [membersRoute, {
      method: "POST",
      path: "/api/v1/admin/member-groups/g-offpeak/members",
      body: {
        requested: 2, succeeded: 1, failed: 1,
        results: [
          { id: "44444444-4444-4444-4444-444444444444", status: "added" },
          { id: "u2", status: "failed", error: "member_not_found" },
        ],
      },
    }]);
    fireEvent.click(await screen.findByRole("button", { name: /Members of Off-peak/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Ada Lovelace/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Thandi Nkosi/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add 2 members to Off-peak" }));

    expect(await screen.findByText("1 of 2 done.")).toBeInTheDocument();
    expect(screen.getByText(/Ada Lovelace — added\./)).toBeInTheDocument();
    expect(screen.getByText(/does not have this member any more/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try the 1 that failed/ })).toBeInTheDocument();
  });
});

describe("the previews, which are the answer to “most restrictive” being an abstraction", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  it("works this group's own week out locally and states every rule that bit", async () => {
    open([OFF_PEAK]);
    fireEvent.click(await screen.findByRole("button", { name: /Preview Off-peak's week/ }));
    expect(await screen.findByText(/Can book 200 of the 436 slots the club is open/)).toBeInTheDocument();
    expect(screen.getByText(/236 slots are blocked by this group's own times/)).toBeInTheDocument();
    // A legend with a word on every swatch — never colour alone.
    const legend = screen.getByRole("list", { name: /What the colours mean/ });
    expect(within(legend).getByText("Allowed")).toBeInTheDocument();
  });

  it("asks the club about one named member, rather than guessing", async () => {
    const stub = open([OFF_PEAK], [{
      path: "/api/v1/admin/members/44444444-4444-4444-4444-444444444444/booking-rules",
      body: bookingRulesFixture(),
    }]);
    fireEvent.click(await screen.findByRole("button", { name: /Preview for one member/ }));
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "Ada" } });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.path.includes("/booking-rules"))).toBe(true));
    // The member's OWN hours, said as the member's — not the club's line under it, which says
    // a different thing with the same figures in it.
    expect(await screen.findByText(/^On a \w+day: 06:00–22:00\.$/)).toBeInTheDocument();
    expect(screen.getByText(/Ada Lovelace is in Regular\./)).toBeInTheDocument();
  });

  /**
   * <b>The second wire call, and the reason it exists.</b> `POST /member-groups/preview` asks
   * what WOULD apply without saving anything, so a membership change states its consequence
   * before it is made rather than after. The saving half lives on the member row, which is
   * another lane's file — this is the same question asked from the group side.
   */
  it("asks what WOULD apply before anything is saved, and says what it costs the member", async () => {
    const stub = open([OFF_PEAK, groupFixture({ id: "g-regular", name: "Regular" })], [
      {
        path: "/api/v1/admin/members/44444444-4444-4444-4444-444444444444/booking-rules",
        body: bookingRulesFixture({ slice_price_credits: 8 }),
      },
      {
        method: "POST",
        path: "/api/v1/admin/member-groups/preview",
        body: bookingRulesFixture({
          groups: [{ id: "g-regular", name: "Regular" }, { id: "g-offpeak", name: "Off-peak" }],
          slice_price_credits: 12,
        }),
      },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: /Preview for one member/ }));
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "Ada" } });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await screen.findByText(/Ada Lovelace is in Regular\./);

    fireEvent.click(screen.getByRole("checkbox", { name: /Off-peak/ }));
    const sent = await waitFor(() => {
      const call = stub.calls.find((c) => c.method === "POST" && c.path.endsWith("/preview"));
      expect(call).toBeTruthy();
      return call!.body as Record<string, unknown>;
    });
    expect(sent.proposedGroupIds).toEqual(["g-regular", "g-offpeak"]);
    expect(await screen.findByText(/A slot will cost Ada Lovelace 12 credits instead of 8\./))
      .toBeInTheDocument();
    // Nothing has been written, and the screen has to say so or an admin walks away believing
    // they have made the change.
    expect(screen.getByText(/Nothing here is saved/)).toBeInTheDocument();
  });

  /**
   * <b>The reachable state D2 §4.3 names.</b> Two groups whose windows do not overlap leave the
   * member nothing, and an empty grid would read as "the club is shut".
   */
  it("names an empty intersection in words instead of drawing a blank week", async () => {
    open([OFF_PEAK], [{
      path: "/api/v1/admin/members/44444444-4444-4444-4444-444444444444/booking-rules",
      body: bookingRulesFixture({
        groups: [
          { id: "a", name: "League members" },
          { id: "b", name: "Non-league members" },
        ],
        allowed_windows: [],
        empty_window_reason: { groups: ["League members", "Non-league members"], day: "tue" },
      }),
    }]);
    fireEvent.click(await screen.findByRole("button", { name: /Preview for one member/ }));
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "Ada" } });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Ada Lovelace/ }));

    expect(await screen.findByText(/their times do not overlap/)).toBeInTheDocument();
    expect(screen.getByText(/nothing she can book on a Tuesday/)).toBeInTheDocument();
  });

  /**
   * <b>`stubFetch` rejects a route with neither `body` nor `respond` BEFORE it looks at
   * `sequence`</b>, which is why `body: null` sits beside the sequence here.
   */
  it("says the preview is stale when the club's hours move under it", async () => {
    open(
      [OFF_PEAK],
      [{ method: "PATCH", path: "/api/v1/admin/member-groups/g-offpeak", body: OFF_PEAK }],
      {
        path: "/api/v1/admin/settings/",
        // `body: null` beside `sequence`, because the stub rejects a route with neither `body`
        // nor `respond` BEFORE it looks at `sequence` — without it every settings call throws
        // and the page reads as unreachable.
        body: null,
        sequence: [CLUB, { ...CLUB, operating_hours: { ...CLUB.operating_hours, sat: "09:00-12:00" } }],
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: /Preview Off-peak's week/ }));
    await screen.findByText(/Can book 200 of the 436 slots/);

    fireEvent.click(screen.getByRole("button", { name: /Edit Off-peak/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Save Off-peak/ }));
    expect(await screen.findByText(/Someone changed the club's opening hours while this was open/))
      .toBeInTheDocument();
  });
});
