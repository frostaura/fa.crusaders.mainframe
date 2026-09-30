import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut, type StubRoute } from "@/test/harness";
import { CONFIRM_NOT_READY, REQUIRED_MARK } from "@/lib/confirmDialogCopy";
import { ACTIONS_COPY as COPY, MEMBER_COPY } from "@/lib/memberDetailCopy";
import { BASE, baseRoutes, detailFixture, renderMember, serve } from "./memberKit";

/**
 * Reset member code — the desk's answer to "I lost my phone" (member-code §10, §13).
 *
 * <p>
 * The route takes the MEMBERSHIP id, not the user id the page is addressed by; it rotates the
 * code, ends every session, and — unless the admin switches it off — deletes the passkeys, since
 * a lost phone's passkey would otherwise sign straight back in. The switch starts ON, the body
 * always carries the choice, and the toast says what went.
 * </p>
 */

const RESET = "/api/v1/admin/members/22222222-2222-2222-2222-222222222222/code/reset";
const NAME = "Thandi Mokoena";

function answer(revoked: boolean, removed: number) {
  return { rotated: true, generation: 3, passkeys_revoked: revoked, passkeys_removed: removed };
}

async function openReset(routes: StubRoute[]) {
  const stub = serve([...baseRoutes(detailFixture()), ...routes]);
  renderMember();
  await screen.findByTestId("member-balance");
  fireEvent.pointerDown(screen.getByRole("button", { name: MEMBER_COPY.moreActions(NAME) }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: COPY.resetCode }));
  const dialog = await screen.findByRole("dialog", { name: COPY.resetCodeTitle(NAME) });
  return { stub, dialog };
}

/** Round-1 contract §7: the desk says why before the reset can go. */
function giveReason(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: COPY.resetCodeReason }), { target: { value: "Lost phone" } });
}

/** Holds the reset's answer until released, so the pending state can be looked at. */
function holdReset() {
  const stubbed = globalThis.fetch;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    (String(input).startsWith(RESET) ? gate.then(() => stubbed(input, init)) : stubbed(input, init)));
  return () => release();
}

describe("member detail — reset member code", () => {
  beforeEach(() => { signOut(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("explains the consequence, offers the passkey switch ON, and has a way out", async () => {
    const { dialog } = await openReset([]);
    expect(within(dialog).getByText(COPY.resetCodeBody)).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: COPY.revokePasskeys })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByText(COPY.revokePasskeysHint)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("names a missing reason when the reset is pressed without one, and sends nothing (F3-18 notReady)", async () => {
    const { stub, dialog } = await openReset([{ method: "POST", path: RESET, body: answer(true, 0) }]);
    const reason = within(dialog).getByRole("textbox", { name: COPY.resetCodeReason });
    // Required, and said so: a visible mark and the attribute, not a disabled button as the only cue.
    expect(reason).toHaveAttribute("aria-required", "true");
    expect(within(dialog).getByText(REQUIRED_MARK)).toBeVisible();
    // No reason, no reset (contract §7) — but the primary stays in the tab order and says why.
    const confirm = within(dialog).getByRole("button", { name: COPY.resetCodeConfirm });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(await within(dialog).findByText(CONFIRM_NOT_READY)).toBeInTheDocument();
    expect(reason).toHaveFocus();
    expect(stub.calls.find((c) => c.path === RESET)).toBeUndefined();
    expect(screen.getByRole("dialog", { name: COPY.resetCodeTitle(NAME) })).toBeInTheDocument();
  });

  it("sends revoke_passkeys:true by default, shows pending, toasts the count and re-reads the member", async () => {
    const { stub, dialog } = await openReset([{ method: "POST", path: RESET, body: answer(true, 2) }]);
    const release = holdReset();
    giveReason(dialog);
    const confirm = within(dialog).getByRole("button", { name: COPY.resetCodeConfirm });
    fireEvent.click(confirm);

    await waitFor(() => expect(confirm).toHaveAttribute("aria-busy", "true"));
    const readsBefore = stub.calls.filter((c) => c.path === BASE).length;
    release();
    // Recorded once the held call reaches the stub.
    await waitFor(() => expect(stub.calls.find((c) => c.path === RESET)?.body).toEqual({ revoke_passkeys: true, reason: "Lost phone" }));

    expect(await screen.findByText(COPY.codeReset(NAME, true, 2))).toBeInTheDocument();
    expect(COPY.codeReset(NAME, true, 2)).toContain("2 passkeys removed");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(stub.calls.filter((c) => c.path === BASE).length).toBeGreaterThan(readsBefore));
  });

  it("keeps the passkeys when the admin switches it off, and says they were kept", async () => {
    const { stub, dialog } = await openReset([{ method: "POST", path: RESET, body: answer(false, 0) }]);
    const toggle = within(dialog).getByRole("switch", { name: COPY.revokePasskeys });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    giveReason(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.resetCodeConfirm }));

    await waitFor(() => expect(stub.calls.find((c) => c.path === RESET)?.body).toEqual({ revoke_passkeys: false, reason: "Lost phone" }));
    expect(await screen.findByText(COPY.codeReset(NAME, false, 0))).toBeInTheDocument();
    expect(COPY.codeReset(NAME, false, 0)).toContain("Their passkeys were kept.");
  });

  it("keeps the dialog open with the refusal in it, and claims nothing", async () => {
    const { dialog } = await openReset([{ method: "POST", path: RESET, status: 500, body: { error: "boom" } }]);
    giveReason(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.resetCodeConfirm }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(new RegExp(`^Couldn't ${COPY.resetCodeAction}`));
    expect(screen.getByRole("dialog", { name: COPY.resetCodeTitle(NAME) })).toBeInTheDocument();
    expect(screen.queryByText(COPY.codeReset(NAME, true, 0))).not.toBeInTheDocument();
  });

  it("is absent for an account with no membership, which the route cannot address", async () => {
    serve(baseRoutes(detailFixture({ membership_id: null, email_verified: false })));
    renderMember();
    await screen.findByTestId("member-balance");
    fireEvent.pointerDown(screen.getByRole("button", { name: MEMBER_COPY.moreActions(NAME) }), { button: 0, ctrlKey: false });
    await screen.findByRole("menuitem", { name: COPY.resendVerification });
    expect(screen.queryByRole("menuitem", { name: COPY.resetCode })).not.toBeInTheDocument();
  });
});
