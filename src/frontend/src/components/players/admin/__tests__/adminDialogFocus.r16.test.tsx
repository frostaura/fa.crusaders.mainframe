import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { DETAIL_ADMIN } from "@/lib/playersCopy";
import { ALEX_SEAT, adminView, seat } from "../../__tests__/detailKit";
import { AdminActDialog } from "../AdminActDialog";
import { AdminAddDialog } from "../AdminAddDialog";
import { ACTS } from "../adminActs";

/**
 * R16 X16-3 — a reason-required dialog refused a press silently: the error appeared, but the
 * keyboard stayed on the confirm button and nothing moved a screen reader to it. Like the desk's
 * Sell sheet, a refused confirm takes focus to the first field with a complaint, whose
 * description carries the complaint.
 */

const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

beforeEach(() => { signIn({ isAdmin: true }); stubFetch([{ path: "/api/v1/admin/members", body: [] }]); });
afterEach(() => { vi.unstubAllGlobals(); signOut(); });

const ALEX = seat({ ...ALEX_SEAT, seat: 2, team: "A", status: "accepted", consented_minutes: 25, target_minutes: 25, share_minutes: 25, paid_minutes: 0, unpaid_minutes: 25 });
const detail = adminView({ players: [seat({ user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen" }), ALEX] });

function described(el: Element): string {
  return (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

describe("the club's seat acts: a refused confirm goes to the complaint (R16 X16-3)", () => {
  it.each(["remove", "settle"] as const)("%s with no reason: focus on the reason, which says it is missing", async (act) => {
    renderPage(<AdminActDialog detail={detail} player={ALEX} act={act} onClose={() => {}} onDone={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: ACTS[act].confirm });
    confirm.focus();
    fireEvent.click(confirm);
    await nextFrame();
    const reason = within(dialog).getByRole("textbox");
    expect(document.activeElement).toBe(reason);
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(described(reason)).toContain(DETAIL_ADMIN.reasonMissing);
  });

  it("collect with a reason but no go-ahead: focus on the go-ahead box, which says it is needed", async () => {
    renderPage(<AdminActDialog detail={detail} player={ALEX} act="collect" onClose={() => {}} onDone={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Paid at the bar" } });
    fireEvent.click(within(dialog).getByRole("button", { name: ACTS.collect.confirm }));
    await nextFrame();
    const box = within(dialog).getByRole("checkbox");
    expect(document.activeElement).toBe(box);
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(described(box)).toContain(DETAIL_ADMIN.overdraftMissing);
  });
});

describe("the club's add: a refused confirm goes to the complaint (R16 X16-3)", () => {
  it("a guest with no name: focus on the name", async () => {
    renderPage(<AdminAddDialog detail={detail} onClose={() => {}} onAdded={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: new RegExp(DETAIL_ADMIN.addGuest) }));
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.addConfirm }));
    await nextFrame();
    const name = within(dialog).getByRole("textbox", { name: DETAIL_ADMIN.guestLabel });
    expect(document.activeElement).toBe(name);
    expect(described(name)).toContain(DETAIL_ADMIN.guestMissing);
  });

  it("a guest named, no reason: focus on the reason", async () => {
    renderPage(<AdminAddDialog detail={detail} onClose={() => {}} onAdded={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: new RegExp(DETAIL_ADMIN.addGuest) }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: DETAIL_ADMIN.guestLabel }), { target: { value: "Kim" } });
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.addConfirm }));
    await nextFrame();
    const reason = within(dialog).getByRole("textbox", { name: DETAIL_ADMIN.reasonLabel });
    expect(document.activeElement).toBe(reason);
    expect(described(reason)).toContain(DETAIL_ADMIN.reasonMissing);
  });

  it("no member picked: focus on the member picker", async () => {
    renderPage(<AdminAddDialog detail={detail} onClose={() => {}} onAdded={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.addConfirm }));
    await nextFrame();
    const picker = document.activeElement as HTMLElement;
    expect(dialog.contains(picker)).toBe(true);
    expect(picker).toHaveAttribute("aria-invalid", "true");
    expect(described(picker)).toContain(DETAIL_ADMIN.memberMissing);
  });
});
