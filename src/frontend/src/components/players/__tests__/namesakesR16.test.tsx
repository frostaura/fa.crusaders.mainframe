import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { DETAIL_ADMIN, PICKER } from "@/lib/playersCopy";
import { PlayerPicker } from "../PlayerPicker";
import { AdminAddDialog } from "../admin/AdminAddDialog";
import { adminView } from "./detailKit";
import { namesakeDetail } from "../picker/namesake";

/**
 * R16 J16-3 — two members called "Pia van Partner" were indistinguishable in the member's partner
 * picker and in the club's Add-a-player combobox. The member's picker shows what the club may tell
 * a member (BE16b: `played_with_you`, `last_played_with_you_at`, `member_since` — never an email,
 * phone or membership number); the admin's shows the membership number and email.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); window.sessionStorage.clear(); });

const PIA_A = { user_id: "pia-a", name: "Pia van Partner", photo_url: null, played_with_you: 3, last_played_with_you_at: "2026-09-23T16:00:00Z", member_since: "2021-06-02" };
const PIA_B = { user_id: "pia-b", name: "Pia van Partner", photo_url: null, played_with_you: 0, last_played_with_you_at: null, member_since: "2024-03-11" };
const PIA_C = { user_id: "pia-c", name: "Pia van Partner", photo_url: null, played_with_you: 1, last_played_with_you_at: "2026-09-01T16:00:00Z", member_since: "2023-09-30" };

function description(el: Element): string {
  // R17 — the painted line keeps a figure with its unit (a no-break space); heard as a plain space.
  return (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(/\u00a0/g, " ").trim();
}

describe("the member's partner picker tells namesakes apart (R16 J16-3)", () => {
  it("the directory: played with you N times · last on …, or member since …", async () => {
    stubFetch([
      { path: "/api/v1/me/partners/favourites", body: { items: [] } },
      { path: "/api/v1/me/partners/recent", body: { items: [] } },
      { path: "/api/v1/members/directory", body: { items: [PIA_A, PIA_B, PIA_C] } },
    ]);
    renderPage(<PlayerPicker onPick={() => {}} excludeUserIds={[]} />);
    await userEvent.setup().click(screen.getByRole("tab", { name: PICKER.members }));
    fireEvent.change(screen.getByLabelText(PICKER.searchLabel), { target: { value: "pia" } });
    const rows = await screen.findAllByRole("button", { name: PICKER.add("Pia van Partner") }, { timeout: 3_000 });
    expect(rows).toHaveLength(3);
    const said = rows.map(description);
    expect(said[0]).toBe(namesakeDetail(PIA_A));
    expect(said[0]).toMatch(/^Played with you 3 times · last on Wed 23 Sep$/);
    expect(said[1]).toBe("Member since Mar 2024");
    expect(said[2]).toMatch(/^Played with you once · last on Tue 1 Sep$/);
    expect(new Set(said).size).toBe(3);
    // Seen, not only heard.
    expect(within(rows[1]).getByText("Member since Mar 2024")).toBeVisible();
    // Never anything a member may not be told.
    expect(document.body.textContent).not.toMatch(/@|#\d/);
  });

  it("a favourite carries the same line; an older API (no fields) shows none", async () => {
    stubFetch([
      { path: "/api/v1/me/partners/favourites", body: { items: [PIA_A, { user_id: "old", name: "Old Api", photo_url: null }] } },
      { path: "/api/v1/me/partners/recent", body: { items: [] } },
    ]);
    renderPage(<PlayerPicker onPick={() => {}} excludeUserIds={[]} />);
    const pia = await screen.findByRole("button", { name: PICKER.add("Pia van Partner") });
    expect(description(pia)).toBe(namesakeDetail(PIA_A));
    const old = screen.getByRole("button", { name: PICKER.add("Old Api") });
    expect(old.getAttribute("aria-describedby")).toBeNull();
  });

  it("member since says September as Sep, never Sept", () => {
    expect(namesakeDetail({ played_with_you: 0, last_played_with_you_at: null, member_since: "2023-09-30" })).toBe("Member since Sep 2023");
    expect(namesakeDetail({})).toBeNull();
  });
});

describe("the club's Add-a-player combobox tells namesakes apart (R16 J16-3)", () => {
  it("each row carries the membership number and email", async () => {
    signIn({ isAdmin: true });
    const member = (id: string, number: string, email: string) => ({
      membership_id: `m-${id}`, user_id: id, email, full_name: "Pia van Partner", membership_number: number, photo_url: null,
      status: "Active", created_at: "2024-01-01T00:00:00Z", rejection_reason: null, balance_minutes: 0,
    });
    stubFetch([{ path: "/api/v1/admin/members", body: [member("pia-a", "1042", "pia@review.test"), member("pia-b", "2210", "pia.vp@review.test")] }]);
    renderPage(<AdminAddDialog detail={adminView()} onClose={() => {}} onAdded={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    await userEvent.setup().click(within(dialog).getByRole("combobox"));
    expect(await screen.findByText(DETAIL_ADMIN.memberSubtitle("1042", "pia@review.test"))).toBeInTheDocument();
    expect(screen.getByText(DETAIL_ADMIN.memberSubtitle("2210", "pia.vp@review.test"))).toBeInTheDocument();
    expect(DETAIL_ADMIN.memberSubtitle("1042", "pia@review.test")).toBe("#1042 · pia@review.test");
  });
});
