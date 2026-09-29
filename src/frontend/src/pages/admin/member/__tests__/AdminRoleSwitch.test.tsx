import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut, type StubRoute } from "@/test/harness";
import { ADMIN_ROLE_CODES, ADMIN_ROLE_COPY as COPY } from "@/lib/memberDetailCopy";
import type { MemberDetail } from "@/lib/memberDetailApi";
import { ADMIN_ID, BASE, MEMBER_ID, baseRoutes, detailFixture, renderMember, serve } from "./memberKit";

/**
 * R20 — granting and revoking admin rights from a member's page.
 *
 * <p>
 * The switch never flips on its own: a press opens a dialog, the dialog's outcome-named primary
 * sends the request, and the switch then shows what the SERVER answered. Every refusal the
 * route can give has its own sentence, shown in the dialog, which stays open.
 * </p>
 */

const ROLE = `${BASE}/admin`;
const SELF_BASE = `/api/v1/admin/members/${ADMIN_ID}`;

function renderAccess(detail: MemberDetail, extra: StubRoute[] = [], userId = MEMBER_ID) {
  const base = userId === MEMBER_ID ? BASE : SELF_BASE;
  // A test that stubs the detail itself (to answer a re-read differently) replaces the default.
  const own = extra.some((r) => r.path === BASE && (r.method ?? "GET") === "GET");
  const routes = (own ? [...baseRoutes(detail).filter((r) => r.path !== BASE), ...extra] : baseRoutes(detail, extra))
    .map((r) => (r.path === BASE ? { ...r, path: base } : r));
  const stub = serve(routes);
  renderMember(`/admin/members/${userId}/access`);
  return stub;
}

const roleSwitch = () => screen.findByRole("switch", { name: COPY.label });

/** Every grant now carries its reason (F3.9). */
function giveReason(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: COPY.reason }), { target: { value: "Committee" } });
}

describe("AdminRoleSwitch", () => {
  beforeEach(() => { signOut(); });

  it("grants only after a confirm WITH a reason (F3.9), sends it, and shows the server's answer", async () => {
    const stub = renderAccess(detailFixture(), [
      { method: "POST", path: ROLE, body: { user_id: MEMBER_ID, is_admin: true, admin_source: "granted", changed: true } },
      // The re-read after the change answers what the server now holds.
      { path: BASE, body: null, sequence: [detailFixture(), detailFixture({ is_admin: true, admin_source: "granted" })] },
    ]);
    const control = await roleSwitch();
    expect(control).toHaveAttribute("aria-checked", "false");

    fireEvent.click(control);
    const dialog = await screen.findByRole("dialog", { name: COPY.grantTitle("Thandi Mokoena") });
    // Pressing the switch changed nothing yet.
    expect(stub.calls.some((c) => c.path === ROLE)).toBe(false);
    const confirm = within(dialog).getByRole("button", { name: COPY.grantConfirm });
    // Review round 1, F3.9 (contract §7): a grant says why, exactly as a revoke does.
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: COPY.reason }), { target: { value: "Joined the committee" } });
    fireEvent.click(confirm);

    await waitFor(() => expect(stub.calls.find((c) => c.path === ROLE)?.body).toEqual({ grant: true, reason: "Joined the committee" }));
    expect(dialog).not.toHaveTextContent(/at a loss/);
    await waitFor(() => expect(screen.getByRole("switch", { name: COPY.label })).toHaveAttribute("aria-checked", "true"));
  });

  it("revokes only with a reason, which is sent", async () => {
    const stub = renderAccess(detailFixture({ is_admin: true, admin_source: "granted" }), [
      { method: "POST", path: ROLE, body: { user_id: MEMBER_ID, is_admin: false, admin_source: null, changed: true } },
    ]);
    fireEvent.click(await roleSwitch());
    const dialog = await screen.findByRole("dialog", { name: COPY.revokeTitle("Thandi Mokoena") });
    const confirm = within(dialog).getByRole("button", { name: COPY.revokeConfirm });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByRole("textbox", { name: COPY.reason }), { target: { value: "Left the committee" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.calls.find((c) => c.path === ROLE)?.body).toEqual({ grant: false, reason: "Left the committee" }));
  });

  it("asks an admin removing their OWN rights for a second, explicit yes (confirm_self)", async () => {
    const selfRole = `${SELF_BASE}/admin`;
    const stub = renderAccess(
      detailFixture({ user_id: ADMIN_ID, is_admin: true, admin_source: "granted" }),
      [{ method: "POST", path: selfRole, body: { user_id: ADMIN_ID, is_admin: false, admin_source: null, changed: true } }],
      ADMIN_ID,
    );
    fireEvent.click(await roleSwitch());
    const dialog = await screen.findByRole("dialog", { name: COPY.revokeSelfTitle });
    const confirm = within(dialog).getByRole("button", { name: COPY.revokeConfirm });

    fireEvent.change(within(dialog).getByRole("textbox", { name: COPY.reason }), { target: { value: "Handing over" } });
    // A reason alone is not enough for yourself.
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: COPY.confirmSelf }));
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.calls.find((c) => c.path === selfRole)?.body)
      .toEqual({ grant: false, reason: "Handing over", confirm_self: true }));
  });

  it("says in words when the club would be left with no administrator (409 last_admin)", async () => {
    renderAccess(detailFixture({ is_admin: true, admin_source: "granted" }), [
      { method: "POST", path: ROLE, status: 409, body: { error: "last_admin" } },
    ]);
    fireEvent.click(await roleSwitch());
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: COPY.reason }), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.revokeConfirm }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(ADMIN_ROLE_CODES.last_admin);
    // Still open, and the switch still says what is true.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // `hidden`: the open modal hides everything behind it from the accessibility tree.
    expect(screen.getByRole("switch", { name: COPY.label, hidden: true })).toHaveAttribute("aria-checked", "true");
  });

  it.each(["not_active_member", "admin_inherited_from_config", "confirm_self_required"])(
    "maps 409 %s to its own sentence",
    async (code) => {
      renderAccess(detailFixture(), [{ method: "POST", path: ROLE, status: 409, body: { error: code } }]);
      fireEvent.click(await roleSwitch());
      const dialog = await screen.findByRole("dialog");
      giveReason(dialog);
      fireEvent.click(within(dialog).getByRole("button", { name: COPY.grantConfirm }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(ADMIN_ROLE_CODES[code]);
    },
  );

  it("maps 403 actor_not_admin to its own sentence", async () => {
    renderAccess(detailFixture(), [{ method: "POST", path: ROLE, status: 403, body: { error: "actor_not_admin" } }]);
    fireEvent.click(await roleSwitch());
    const dialog = await screen.findByRole("dialog");
    giveReason(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.grantConfirm }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(ADMIN_ROLE_CODES.actor_not_admin);
  });

  it("locks a config admin's switch and says where the right comes from", async () => {
    renderAccess(detailFixture({ is_admin: true, admin_source: "config" }));
    const control = await roleSwitch();
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(COPY.configLocked)).toBeInTheDocument();
  });

  it("will not offer admin to a member who is not active, and says why before anyone presses", async () => {
    renderAccess(detailFixture({ status: "PendingApproval" }));
    expect(await roleSwitch()).toBeDisabled();
    expect(screen.getByText(COPY.notActive)).toBeInTheDocument();
  });
});
