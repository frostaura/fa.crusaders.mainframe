import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { memberFixture, renderPage, stubFetch, type StubRoute } from "../test/harness";
import { COLUMNS, MEMBERS_PAGE, ROW_ACTIONS, SUSPENDED_NOTE } from "../lib/membersCopy";

/**
 * The members table's shape — the decisions that produced the measured pixels, since jsdom has
 * no layout. `e2e/admin-members-layout.spec.ts` re-measures the pixels in Chromium.
 *
 * <p>
 * <b>What P5 changed, and what it kept.</b> The table is now a table only when its CARD is at least
 * 48rem wide, and a stack of cards below that — one threshold family, all container queries in
 * rem, so a raised root font gets cards rather than a squeezed Name column. The columns were
 * re-cut (Email and Member # moved under the name; Class moved into the ⋯ menu; Groups arrived),
 * so the assertions that named the old columns and their px widths were rewritten. Every
 * invariant they held is still here: the scroll region names itself; every field carries the
 * label its card form prints; the name stays put while the row scrolls; the row actions run
 * along one line; Balance and Actions are pinned with ONE shared number; each optional column
 * has exactly one threshold and is not drawn below it.
 * </p>
 */

afterEach(() => vi.unstubAllGlobals());

const TABLE = "[@container(min-width:48rem)]";

function renderMembers(extra: StubRoute[] = [], members = [memberFixture()]) {
  stubFetch([
    { path: "/api/v1/admin/members/", body: members },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ...extra,
  ]);
  return renderPage(<AdminMembersPage />);
}

/** A club whose groups can be read, so the Groups column is drawn. */
const GROUP_ROUTES: StubRoute[] = [
  { path: "/api/v1/admin/member-groups", body: { groups: [{ id: "g1", name: "League" }] } },
  { path: "/api/v1/admin/member-groups/g1/members", body: { members: [{ user_id: "44444444-4444-4444-4444-444444444444", name: "Ada Lovelace" }], cursor: null } },
];

describe("the admin members table", () => {
  it("says it scrolls sideways instead of hiding the columns silently", async () => {
    renderMembers();
    const region = await screen.findByRole("region", { name: MEMBERS_PAGE.tableLabel });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.querySelector("table")).not.toBeNull();
  });

  it("labels every field, so the phone card says what the header row would have said", async () => {
    renderMembers(GROUP_ROUTES);
    await screen.findByText("League");
    const labelled = Array.from(document.querySelectorAll("tbody td[data-label]")).map((td) => td.getAttribute("data-label"));
    expect(labelled).toEqual([COLUMNS.status, COLUMNS.groups, COLUMNS.joined, COLUMNS.balance, COLUMNS.actions]);
  });

  it("keeps the member's name in place while the rest of the row scrolls", async () => {
    renderMembers();
    await screen.findByText("Ada Lovelace");
    const identity = document.querySelector("tbody tr > td:first-child")!;
    // An opaque fill as well, or the columns passing underneath read straight through it.
    expect(identity.className).toContain(`${TABLE}:sticky`);
    expect(identity.className).toContain(`${TABLE}:left-0`);
    expect(identity.className).toContain(`${TABLE}:bg-bg-surface`);
  });

  it("lays the row actions along the row, not down it", async () => {
    renderMembers();
    const actions = (await screen.findByRole("button", { name: ROW_ACTIONS.topUp })).parentElement!;
    // Wrapping lets the table squeeze this column and the buttons stack — measured at 92.5-136.5px
    // rows against 60.5-69px on one line. Wrapping is the cause of the tall row, not the cure.
    expect(actions.className).toContain("flex-row");
    expect(actions.className).not.toContain("flex-col");
    expect(actions.className).not.toContain("flex-wrap");
  });

  it("pins the actions column so the buttons do not start off-screen", async () => {
    renderMembers();
    const cell = (await screen.findByRole("button", { name: ROW_ACTIONS.topUp })).closest("td")!;
    const header = screen.getByRole("columnheader", { name: COLUMNS.actions });
    expect(cell.className).toContain(`${TABLE}:sticky`);
    expect(cell.className).toContain(`${TABLE}:right-0`);
    expect(cell.className).toContain(`${TABLE}:bg-bg-surface`);
    expect(header.className).toMatch(/(^|\s)sticky(\s|$)/);
    expect(header.className).toMatch(/(^|\s)right-0(\s|$)/);
  });

  /**
   * A balance partly covered once read `123456.78 cr` as `12345`. The balance's pin offset must
   * equal the width the actions column is held to — one number, compared rather than asserted
   * alone — and the two pinned cells must be adjacent, or a scrolling column shows through the seam.
   */
  it("pins the balance beside the actions, at the offset that clears them", async () => {
    renderMembers();
    await screen.findByText("Ada Lovelace");
    const balance = document.querySelector<HTMLElement>('tbody td[data-label="Balance"]')!;
    const actions = document.querySelector<HTMLElement>('tbody td[data-label="Actions"]')!;
    const offset = new RegExp(`${escape(TABLE)}:right-(\\d+)`).exec(balance.className)?.[1];
    const width = new RegExp(`${escape(TABLE)}:w-(\\d+)`).exec(actions.className)?.[1];
    expect(balance.className).toContain(`${TABLE}:sticky`);
    expect(offset, "balance cell needs a pin offset on the spacing scale").toBeDefined();
    expect(offset).toBe(width);

    const header = screen.getByRole("columnheader", { name: COLUMNS.balance });
    const actionsHeader = screen.getByRole("columnheader", { name: COLUMNS.actions });
    expect(/(?:^|\s)right-(\d+)/.exec(header.className)?.[1]).toBe(offset);
    expect(/(?:^|\s)w-(\d+)/.exec(actionsHeader.className)?.[1]).toBe(width);

    const labels = Array.from(document.querySelectorAll("tbody tr:first-child td[data-label]")).map((td) => td.getAttribute("data-label"));
    expect(labels.indexOf(COLUMNS.balance)).toBe(labels.indexOf(COLUMNS.actions) - 1);
  });

  /**
   * Each optional column has ONE threshold, on the card's width in rem, and below it the column is
   * not drawn rather than drawn under a pin. Below the table threshold nothing is a column at all:
   * every field is on the card.
   */
  it("draws a column only from the card width at which it fits", async () => {
    renderMembers(GROUP_ROUTES);
    await screen.findByText("League");

    const expected: Record<string, string> = {
      [COLUMNS.groups]: "[@container(min-width:59rem)]:!table-cell",
      [COLUMNS.joined]: "[@container(min-width:65rem)]:!table-cell",
    };
    for (const [label, threshold] of Object.entries(expected)) {
      const header = screen.getByRole("columnheader", { name: new RegExp(`^${label}`) });
      expect(header.className, `${label} header`).toMatch(/(^|\s)hidden(\s|$)/);
      expect(header.className, `${label} header`).toContain(threshold);
      const cell = document.querySelector<HTMLElement>(`tbody td[data-label="${label}"]`)!;
      expect(cell.className, `${label} cell`).toContain(`${TABLE}:hidden`);
      expect(cell.className, `${label} cell`).toContain(threshold);
    }
    // Identity, state, money and the things an admin came here to press never drop.
    for (const label of [COLUMNS.status, COLUMNS.balance, COLUMNS.actions]) {
      const cell = document.querySelector<HTMLElement>(`tbody td[data-label="${label}"]`)!;
      expect(cell.className, `${label} cell`).not.toContain(`${TABLE}:hidden`);
      expect(cell.className, `${label} cell`).toContain(`${TABLE}:table-cell`);
    }
  });

  it("is a table only from the card width where its fixed columns and a readable name fit", async () => {
    renderMembers();
    const table = (await screen.findByRole("region", { name: MEMBERS_PAGE.tableLabel })).querySelector("table")!;
    expect(table.className).toContain(`${TABLE}:table`);
    expect(table.className).toContain(`${TABLE}:table-fixed`);
    expect(table.className).toMatch(/(^|\s)block(\s|$)/);
  });
});

/** Escape a class prefix for a RegExp. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\:@]/g, "\\$&");
}

/**
 * The row's own controls, at the size a club actually uses.
 */
describe("the members table's own controls", () => {
  const routes = (): StubRoute[] => [
    { path: "/api/v1/admin/members/", body: [
      memberFixture({ status: "PendingApproval" }),
      memberFixture({ membership_id: "m2", user_id: "u2", full_name: "Grace Hopper", status: "Suspended" }),
      memberFixture({ membership_id: "m3", user_id: "u3", full_name: "Alan Turing", member_class: "LeagueOrSenior" }),
    ] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
  ];

  /**
   * D3-B07: approving somebody is what lets them through a door, so these are never smaller than
   * a finger. P5 uses the design system's dense admin size — 36px to the eye, 44px to the finger
   * through the button's own extended hit area — so a pending row's three controls fit its line.
   */
  it("gives Approve and Reject a 44px target", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);
    for (const name of [ROW_ACTIONS.approve, ROW_ACTIONS.reject]) {
      const control = await screen.findByRole("button", { name });
      expect(control.className, `${name} lost its extended hit area`).toContain("after:-inset-y-[5px]");
    }
    const more = screen.getByRole("button", { name: ROW_ACTIONS.more("Ada Lovelace") });
    expect(more.className).toContain("after:-inset-[5px]");
  });

  /**
   * D3-B18: two controls vanishing from a suspended row with nothing saying why reads as a
   * rendering fault. In the row, not in a tooltip — a title is invisible on a phone.
   */
  it("says why a suspended member's row has no Top up", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);
    const said = await screen.findByText(SUSPENDED_NOTE);
    const row = said.closest("tr")!;
    expect(within(row).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: ROW_ACTIONS.topUp })).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: ROW_ACTIONS.more("Grace Hopper") })).toBeInTheDocument();
  });
});
