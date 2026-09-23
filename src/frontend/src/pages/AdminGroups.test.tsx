import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AdminGroupsPage } from "./AdminGroups";
import { SETTINGS_FIXTURE, memberFixture, renderPage, signIn, stubFetch, type StubRoute } from "../test/harness";
import {
  bookingRulesFixture, groupFixture, groupMemberFixture, restrictedGroupFixture, weekdayWindows,
} from "../test/groupFixtures";
import type { MemberGroup } from "../lib/adminApi";
import { ARCHIVED_HEADING, ARCHIVE_COPY, ASSIGN_COPY, GROUP_ACTIONS, GROUP_SHEET, RATE_COPY } from "../lib/groupsCopy";

/**
 * A card's consequential actions live behind its ⋯ menu and a confirm dialog (P3 — they were
 * inline two-tap ConfirmButtons, which is what the old "choose again to confirm" steps drove).
 */
async function fromMenu(group: string, item: string) {
  fireEvent.pointerDown(await screen.findByRole("button", { name: GROUP_ACTIONS.more(group) }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: item }));
}

/**
 * Archive asks WHY (D2 — an archive changes what every member of the group pays): open it from the
 * menu, give the reason the change record needs, confirm.
 */
async function archiveFromMenu(group: string, reason = "Season over") {
  fireEvent.pointerDown(await screen.findByRole("button", { name: GROUP_ACTIONS.more(group) }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: GROUP_ACTIONS.archive }));
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: ARCHIVE_COPY.confirm });
  expect(confirm, "no archive without a reason").toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText(ARCHIVE_COPY.reasonLabel), { target: { value: reason } });
  fireEvent.click(confirm);
}

/** The editor's primary, named with the group ("Save changes to Off-peak"). */
const SAVE = (group: string) => ({ name: `${GROUP_SHEET.save} to ${group}` });

/** MemberCombobox (P3 replaced the hand-built MemberPicker): open it, choose by name. */
async function pickMember(label: RegExp, name: RegExp) {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name }));
}

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

    await archiveFromMenu("Off-peak");

    // The band, and its standing announcement (a separate invisible region) — both say it.
    expect((await screen.findAllByText(/Couldn't read the club's groups\. Nothing has changed\./)).length).toBeGreaterThan(0);
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
    // A group that inherits is quoted at the club's rate: one R100 block, 160 credits.
    expect(await screen.findByText(/R100 → 160 cr/)).toBeInTheDocument();
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
    // A switch now (P3, R7 — Switch for booleans); the rule it carries is unchanged.
    const box = await screen.findByRole("switch", { name: /Use the club's limit for slots a day/ });
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
    fireEvent.click(await screen.findByRole("switch", { name: /Use the club's limit for slots a day/ }));
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
    fireEvent.click(await screen.findByRole("button", SAVE("Off-peak")));
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
    fireEvent.click(await screen.findByRole("button", SAVE("Off-peak")));
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
    await fromMenu("Off-peak", GROUP_ACTIONS.remove);

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
    fireEvent.pointerDown(screen.getByRole("button", { name: GROUP_ACTIONS.more("Regular") }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(await screen.findByRole("menuitem", { name: GROUP_ACTIONS.archive })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: GROUP_ACTIONS.remove })).not.toBeInTheDocument();
    expect(screen.getByText(/one of the club's two standing groups/)).toBeInTheDocument();
  });

  it("archives with a PATCH, which is the reversible escape the refusal names", async () => {
    const stub = open([OFF_PEAK], [{
      method: "PATCH",
      path: "/api/v1/admin/member-groups/g-offpeak",
      body: { ...OFF_PEAK, status: "archived" },
    }]);
    await archiveFromMenu("Off-peak", "Nobody plays off-peak any more");
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PATCH")).toBe(true));
    // The reason travels with it: the change record's words for why every member's rules moved.
    expect(stub.calls.find((c) => c.method === "PATCH")!.body)
      .toEqual({ status: "archived", reason: "Nobody plays off-peak any more" });
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
    await pickMember(/^Add somebody/, /Thandi Nkosi/);
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
    await pickMember(/^Add somebody/, /Ada Lovelace/);
    await pickMember(/^Add somebody/, /Thandi Nkosi/);
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
    fireEvent.click(await screen.findByRole("button", { name: /Preview week for Off-peak/ }));
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
    await pickMember(/^Which member/, /Ada Lovelace/);
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
    await pickMember(/^Which member/, /Ada Lovelace/);
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
    await pickMember(/^Which member/, /Ada Lovelace/);

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
    fireEvent.click(await screen.findByRole("button", { name: /Preview week for Off-peak/ }));
    await screen.findByText(/Can book 200 of the 436 slots/);

    fireEvent.click(screen.getByRole("button", { name: /Edit Off-peak/ }));
    fireEvent.click(await screen.findByRole("button", SAVE("Off-peak")));
    expect(await screen.findByText(/Someone changed the club's opening hours while this was open/))
      .toBeInTheDocument();
  });
});

/**
 * D2 — the group carries the top-up rate and the peak say the member class used to, so this page
 * is the one place both are set. Both are tri-state on the wire and the page has to keep them so:
 * a rate is inherited (null) or a figure; a peak say grants, withholds, or has none.
 */
describe("the top-up rate and peak hours (D2: groups replaced the class)", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  const LEAGUE = groupFixture({
    id: "g-league", name: "League", is_system_default: false, system_key: "league",
    credits_per_zar: 2.4, peak_priority: true, member_count: 12,
  });
  const JUNIORS = restrictedGroupFixture({ id: "g-juniors", name: "Juniors", credits_per_zar: null, peak_priority: false });

  it("says each group's rate and peak say on its card, in words beside an icon", async () => {
    open([LEAGUE, JUNIORS]);
    const league = await screen.findByRole("list", { name: "League at a glance" });
    expect(within(league).getByText("2.4 cr per R1")).toBeInTheDocument();
    expect(within(league).getByText("Grants peak")).toBeInTheDocument();
    const juniors = screen.getByRole("list", { name: "Juniors at a glance" });
    expect(within(juniors).getByText("Club rate")).toBeInTheDocument();
    expect(within(juniors).getByText("Withholds peak")).toBeInTheDocument();
    // What a block buys at the group's OWN rate, not the club's.
    expect(screen.getByText(/R100 → 240 cr/)).toBeInTheDocument();
  });

  /**
   * The league group carries the club's rates, and the server refuses both archive and delete
   * (409 group_is_system_default) — so neither is offered, and the card says why.
   */
  it("offers the built-in league group neither archive nor delete, and says why", async () => {
    open([LEAGUE]);
    await screen.findByRole("heading", { name: "League" });
    expect(screen.getByText("Built in")).toBeInTheDocument();
    expect(screen.getByText(/replaced the league \/ over-65 member class/)).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: GROUP_ACTIONS.more("League") }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    // Nothing safe or destructive to offer: the menu has no archive and no delete.
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: GROUP_ACTIONS.archive })).not.toBeInTheDocument());
    expect(screen.queryByRole("menuitem", { name: GROUP_ACTIONS.remove })).not.toBeInTheDocument();
  });

  it("previews what a block buys at the rate being typed, and sends the rate and the peak say", async () => {
    const stub = open([JUNIORS], [{ method: "PATCH", path: "/api/v1/admin/member-groups/g-juniors", body: JUNIORS }]);
    fireEvent.click(await screen.findByRole("button", { name: /Edit Juniors/ }));

    const inherit = await screen.findByRole("switch", { name: RATE_COPY.inherit });
    expect(inherit, "a group with no rate of its own inherits the club's").toBeChecked();
    fireEvent.click(inherit);
    fireEvent.change(screen.getByLabelText(RATE_COPY.field()), { target: { value: "2.4" } });
    expect(await screen.findByText("R100 → 240 cr")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Grants peak priority" }));
    fireEvent.click(screen.getByRole("button", SAVE("Juniors")));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = stub.calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(sent.creditsPerZar).toBe(2.4);
    expect(sent.peakPriority).toBe(true);
  });

  it("sends null for an inherited rate and for “no say”, never an absent field", async () => {
    const stub = open([LEAGUE], [{ method: "PATCH", path: "/api/v1/admin/member-groups/g-league", body: LEAGUE }]);
    fireEvent.click(await screen.findByRole("button", { name: /Edit League/ }));
    fireEvent.click(await screen.findByRole("switch", { name: RATE_COPY.inherit }));
    fireEvent.click(screen.getByRole("radio", { name: "No say" }));
    fireEvent.click(screen.getByRole("button", SAVE("League")));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = stub.calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(sent).toHaveProperty("creditsPerZar", null);
    expect(sent).toHaveProperty("peakPriority", null);
  });

  /** The server's own bounds, said at the field — never a save that the club then refuses. */
  it("refuses a rate the club would refuse, at the field, and sends nothing", async () => {
    const stub = open([JUNIORS]);
    fireEvent.click(await screen.findByRole("button", { name: /Edit Juniors/ }));
    fireEvent.click(await screen.findByRole("switch", { name: RATE_COPY.inherit }));
    fireEvent.change(screen.getByLabelText(RATE_COPY.field()), { target: { value: "2.12345" } });
    fireEvent.click(screen.getByRole("button", SAVE("Juniors")));
    expect(await screen.findByText("Use at most 4 decimal places.")).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("explains how several groups combine for peak hours, beside the choice", async () => {
    open([JUNIORS]);
    fireEvent.click(await screen.findByRole("button", { name: /Edit Juniors/ }));
    expect(await screen.findByText(/at least one of their groups grants it and none of them withholds it/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Withholds it" })).toBeChecked();
    // The club's own window, so the choice is about a real stretch of the day.
    expect(screen.getByText(/The club's peak hours are 16:00–19:00/)).toBeInTheDocument();
  });

  it("files archived groups under their own heading, and brings one back", async () => {
    const ARCHIVED = restrictedGroupFixture({ status: "archived" });
    const stub = open([LEAGUE, ARCHIVED], [{ method: "PATCH", path: "/api/v1/admin/member-groups/g-offpeak", body: { ...ARCHIVED, status: "active" } }]);
    expect(await screen.findByRole("heading", { name: `${ARCHIVED_HEADING} (1)` })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: GROUP_ACTIONS.more("Off-peak") }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: ARCHIVE_COPY.restore }));
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "active" }));
  });
});

describe("moving somebody between groups from the group's own members tab", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  it("opens GroupAssign on the member's saved groups, read from the member", async () => {
    const stub = open([OFF_PEAK], [
      {
        path: "/api/v1/admin/member-groups/g-offpeak/members",
        body: { members: [groupMemberFixture({ user_id: "u9", name: "Sipho Dlamini", membership_number: "CR-0009" })], total: 1, cursor: null },
      },
      { path: "/api/v1/admin/members/u9", body: { user_id: "u9", full_name: "Sipho Dlamini", groups: [{ id: "g-offpeak", name: "Off-peak" }] } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: /Members of Off-peak/ }));
    fireEvent.click(await screen.findByRole("button", { name: ASSIGN_COPY.changeFor("Sipho Dlamini") }));
    const dialog = await screen.findByRole("dialog", { name: ASSIGN_COPY.title("Sipho Dlamini") });
    const chips = await within(dialog).findByRole("list", { name: "Chosen groups" });
    expect(within(chips).getByText("Off-peak")).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path === "/api/v1/admin/members/u9")).toBe(true);
    // Nothing changed yet, so there is nothing to save — and the button says so.
    expect(within(dialog).getByRole("button", { name: ASSIGN_COPY.unchanged })).toBeDisabled();
  });
});
