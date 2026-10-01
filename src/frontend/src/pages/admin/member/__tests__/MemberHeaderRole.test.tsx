import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { ADMIN_ROLE_COPY as COPY, MEMBER_COPY } from "@/lib/memberDetailCopy";
import { BASE, baseRoutes, detailFixture, renderMember, serve } from "./memberKit";

/**
 * R5 lane G — the plan put the role control on the record's header; Dean found it nowhere. The
 * header's ⋯ now offers it, through the same dialog as the Access tab's switch, and the header's
 * Admin badge is drawn from the server's answer.
 */

// The record, a Radix menu and a dialog: past the 5 s default under three lanes' load.
vi.setConfig({ testTimeout: 20_000 });

const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;
const ROLE = `${BASE}/admin`;
const NAME = "Thandi Mokoena";

async function openHeaderMenu() {
  fireEvent.pointerDown(await screen.findByRole("button", { name: MEMBER_COPY.moreActions(NAME) }), POINTER);
  return screen.findByRole("menu");
}

describe("the record header's ⋯ and the admin role", () => {
  beforeEach(() => { signOut(); });

  it("makes an administrator from the header, and the badge follows the server's answer", async () => {
    const stub = serve([
      ...baseRoutes(detailFixture()).filter((r) => r.path !== BASE),
      // The re-read after the change answers what the server now holds.
      { path: BASE, body: null, sequence: [detailFixture(), detailFixture({ is_admin: true, admin_source: "granted" })] },
      { method: "POST", path: ROLE, body: { user_id: detailFixture().user_id, is_admin: true, admin_source: "granted", changed: true } },
    ]);
    renderMember();
    expect(await screen.findByRole("heading", { name: NAME })).toBeInTheDocument();
    expect(screen.queryByText(MEMBER_COPY.adminBadge)).not.toBeInTheDocument();

    const menu = await openHeaderMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: COPY.grantConfirm }));
    const dialog = await screen.findByRole("dialog", { name: COPY.grantTitle(NAME) });
    fireEvent.change(within(dialog).getByRole("textbox", { name: COPY.reason }), { target: { value: "Treasurer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.grantConfirm }));

    await waitFor(() => expect(stub.calls.find((c) => c.path === ROLE)?.body).toEqual({ grant: true, reason: "Treasurer" }));
    expect(await screen.findByText(MEMBER_COPY.adminBadge)).toBeInTheDocument();
  });

  it("shows a config admin's item disabled, with the reason", async () => {
    serve(baseRoutes(detailFixture({ is_admin: true, admin_source: "config" })));
    renderMember();
    const menu = await openHeaderMenu();
    const item = within(menu).getByRole("menuitem", { name: new RegExp(COPY.revokeConfirm) });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent(COPY.menuConfigLocked);
  });

  it("offers Remove admin rights to an admin the club made", async () => {
    serve(baseRoutes(detailFixture({ is_admin: true, admin_source: "granted" })));
    renderMember();
    const menu = await openHeaderMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: COPY.revokeConfirm }));
    expect(await screen.findByRole("dialog", { name: COPY.revokeTitle(NAME) })).toBeInTheDocument();
  });
});
