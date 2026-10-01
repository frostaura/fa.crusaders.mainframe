import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { memberFixture, refuse, renderPage, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";
import { ADMIN_BADGE, ROW_ACTIONS, STATUS_FILTERS } from "../lib/membersCopy";
import { ADMIN_ROLE_CODES, ADMIN_ROLE_COPY as COPY } from "../lib/memberDetailCopy";
import { LOST_REPLY } from "../lib/lostReplyCopy";

/**
 * R5 lane G — Dean: "there is still no way to make a user an admin yet … that should be easy from
 * the members list too". The row's ⋯ offers Make administrator / Remove admin rights through the
 * SAME dialog as the member's Access tab (`AdminRoleDialog`), on the switch's own rule
 * (`adminRoleOffer`), and the row redraws from the server's answer — never before it.
 */

// The whole page, a Radix menu and a dialog per test: ~3.7 s each at load 27, past the 5 s default
// at load 50 with three lanes running (measured 2026-10-01). Precedent: settings-version, invite-join.
vi.setConfig({ testTimeout: 20_000 });

const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;
const LIST = "/api/v1/admin/members/";

/** The signed-in admin (the harness's session user) — Ada, so the self case is a real row. */
const SELF = memberFixture({ is_admin: true, admin_source: "granted" });
const BEA = memberFixture({ membership_id: "m-bea", user_id: "u-bea", full_name: "Bea Nkosi", email: "bea@x.test", membership_number: "CR-0010", is_admin: false, admin_source: null });
const CAM = memberFixture({ membership_id: "m-cam", user_id: "u-cam", full_name: "Cam Pillay", email: "cam@x.test", membership_number: "CR-0011", is_admin: true, admin_source: "granted" });
const OPS = memberFixture({ membership_id: "m-ops", user_id: "u-ops", full_name: "Ops Desk", email: "ops@x.test", membership_number: "CR-0012", is_admin: true, admin_source: "config" });
const SAL = memberFixture({ membership_id: "m-sal", user_id: "u-sal", full_name: "Sal Suspended", email: "sal@x.test", membership_number: "CR-0013", status: "Suspended", is_admin: false, admin_source: null });
const OLD = memberFixture({ membership_id: "m-old", user_id: "u-old", full_name: "Old Api", email: "old@x.test", membership_number: "CR-0014" });

function render(extra: StubRoute[] = [], members: unknown[] = [SELF, BEA, CAM, OPS, SAL, OLD]) {
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/wallet", body: { balance_credits: 0 } },
    { path: LIST, body: members },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ...extra,
  ]);
  renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members"] });
  return stub;
}

// `hidden`: an open modal hides everything behind it from the accessibility tree.
const rowOf = async (name: string) => (await screen.findByRole("link", { name, hidden: true })).closest("tr")!;

async function openMenu(name: string) {
  fireEvent.pointerDown(await screen.findByRole("button", { name: ROW_ACTIONS.more(name) }), POINTER);
  return screen.findByRole("menu");
}

async function choose(name: string, label: string) {
  const menu = await openMenu(name);
  fireEvent.click(within(menu).getByRole("menuitem", { name: label }));
}

function giveReason(dialog: HTMLElement, text = "Joined the committee") {
  fireEvent.change(within(dialog).getByRole("textbox", { name: COPY.reason }), { target: { value: text } });
}

const roleCall = (stub: ReturnType<typeof stubFetch>, userId: string) =>
  stub.calls.find((c) => c.method === "POST" && c.path === `${LIST}${userId}/admin`);

beforeEach(() => signOut());
afterEach(() => vi.unstubAllGlobals());

describe("the row ⋯ offers the role, on the switch's rule", () => {
  it("offers Make administrator to an active member who is not one", async () => {
    render();
    const menu = await openMenu(BEA.full_name);
    const item = within(menu).getByRole("menuitem", { name: COPY.grantConfirm });
    expect(item).not.toHaveAttribute("aria-disabled");
    expect(within(menu).queryByRole("menuitem", { name: COPY.revokeConfirm })).not.toBeInTheDocument();
  });

  it("offers Remove admin rights to an admin the club made", async () => {
    render();
    const menu = await openMenu(CAM.full_name);
    expect(within(menu).getByRole("menuitem", { name: COPY.revokeConfirm })).not.toHaveAttribute("aria-disabled");
    expect(within(menu).queryByRole("menuitem", { name: COPY.grantConfirm })).not.toBeInTheDocument();
  });

  it("shows a config admin's item disabled, with the reason", async () => {
    render();
    const menu = await openMenu(OPS.full_name);
    const item = within(menu).getByRole("menuitem", { name: new RegExp(COPY.revokeConfirm) });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent(COPY.menuConfigLocked);
  });

  it("shows a non-active member's grant disabled, with the reason", async () => {
    render();
    const menu = await openMenu(SAL.full_name);
    const item = within(menu).getByRole("menuitem", { name: new RegExp(COPY.grantConfirm) });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent(COPY.menuNotActive);
  });

  it("offers nothing about the role when the list did not say whether they are an admin", async () => {
    render();
    const menu = await openMenu(OLD.full_name);
    expect(within(menu).queryByRole("menuitem", { name: new RegExp(`${COPY.grantConfirm}|${COPY.revokeConfirm}`) })).not.toBeInTheDocument();
  });

  it("asks the signed-in admin removing their OWN rights for the second yes (confirm_self)", async () => {
    const stub = render([{ method: "POST", path: `${LIST}${SELF.user_id}/admin`, body: { user_id: SELF.user_id, is_admin: false, admin_source: null, changed: true } }]);
    await choose(SELF.full_name, COPY.revokeConfirm);
    const dialog = await screen.findByRole("dialog", { name: COPY.revokeSelfTitle });
    giveReason(dialog, "Handing over");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: COPY.confirmSelf }));
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.revokeConfirm }));
    await waitFor(() => expect(roleCall(stub, SELF.user_id)?.body).toEqual({ grant: false, reason: "Handing over", confirm_self: true }));
  });
});

describe("the act, from the list", () => {
  it("grants with a reason, sends it, and draws the Admin badge only once the server has answered", async () => {
    let answer: (() => void) | null = null;
    const stub = render([{
      method: "POST", path: `${LIST}${BEA.user_id}/admin`,
      body: { user_id: BEA.user_id, is_admin: true, admin_source: "granted", changed: true },
    }]);
    // Hold the reply, to see the row before it lands.
    type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    const fetchMock = vi.mocked(globalThis.fetch);
    const real = fetchMock.getMockImplementation() as Fetch;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "POST" || !String(input).endsWith("/admin")) return real(input, init);
      const reply = real(input, init);
      return new Promise((resolve) => { answer = () => resolve(reply); });
    });

    await choose(BEA.full_name, COPY.grantConfirm);
    const dialog = await screen.findByRole("dialog", { name: COPY.grantTitle(BEA.full_name) });
    giveReason(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.grantConfirm }));
    await waitFor(() => expect(roleCall(stub, BEA.user_id)?.body).toEqual({ grant: true, reason: "Joined the committee" }));
    // Never optimistic: sent, not answered — no badge yet.
    expect(within(await rowOf(BEA.full_name)).queryByText(ADMIN_BADGE.label)).not.toBeInTheDocument();

    answer!();
    await waitFor(async () => expect(within(await rowOf(BEA.full_name)).getByText(ADMIN_BADGE.label)).toBeInTheDocument());
    expect(await screen.findByText(COPY.granted(BEA.full_name))).toBeInTheDocument();
  });

  it("revokes with a reason, and the badge goes when the server says so", async () => {
    const stub = render([{ method: "POST", path: `${LIST}${CAM.user_id}/admin`, body: { user_id: CAM.user_id, is_admin: false, admin_source: null, changed: true } }]);
    expect(within(await rowOf(CAM.full_name)).getByText(ADMIN_BADGE.label)).toBeInTheDocument();
    await choose(CAM.full_name, COPY.revokeConfirm);
    const dialog = await screen.findByRole("dialog", { name: COPY.revokeTitle(CAM.full_name) });
    giveReason(dialog, "Left the committee");
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.revokeConfirm }));
    await waitFor(() => expect(roleCall(stub, CAM.user_id)?.body).toEqual({ grant: false, reason: "Left the committee" }));
    await waitFor(async () => expect(within(await rowOf(CAM.full_name)).queryByText(ADMIN_BADGE.label)).not.toBeInTheDocument());
  });

  it("says a refusal (409 last_admin) in the dialog, which stays open, and leaves the row as it was", async () => {
    render([{ method: "POST", path: `${LIST}${CAM.user_id}/admin`, status: 409, body: { error: "last_admin" } }]);
    await choose(CAM.full_name, COPY.revokeConfirm);
    const dialog = await screen.findByRole("dialog");
    giveReason(dialog, "x");
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.revokeConfirm }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(ADMIN_ROLE_CODES.last_admin);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(await rowOf(CAM.full_name)).getByText(ADMIN_BADGE.label)).toBeInTheDocument();
  });

  it("reads a lost reply back: the grant landed, so it says so and the row shows it", async () => {
    let admin = false;
    render([
      { method: "POST", path: `${LIST}${BEA.user_id}/admin`, respond: () => { admin = true; return refuse(504, { error: "gateway_timeout" }); } },
      { path: `${LIST}${BEA.user_id}`, respond: () => ({ ...BEA, is_admin: admin, admin_source: admin ? "granted" : null }) },
    ]);
    await choose(BEA.full_name, COPY.grantConfirm);
    const dialog = await screen.findByRole("dialog");
    giveReason(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.grantConfirm }));
    expect(await screen.findByText(LOST_REPLY.proven(COPY.granted(BEA.full_name)))).toBeInTheDocument();
    await waitFor(async () => expect(within(await rowOf(BEA.full_name)).getByText(ADMIN_BADGE.label)).toBeInTheDocument());
  });
});

describe("the Admins chip", () => {
  it("counts the club's administrators and shows only them", async () => {
    render();
    const chip = await screen.findByRole("radio", { name: new RegExp(STATUS_FILTERS.find((f) => f.value === "admins")!.label) });
    expect(chip).toHaveTextContent("3");
    fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByRole("link", { name: BEA.full_name })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: CAM.full_name })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: OPS.full_name })).toBeInTheDocument();
  });
});
