import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Layout from "./Layout";
import { AuthProvider } from "../lib/auth";
import { BalanceProvider } from "../lib/balance";
import { ProfileProvider } from "../lib/profile";
import { memberFixture, signIn, signOut, stubFetch } from "../test/harness";

/**
 * The app chrome, and the one thing it never said.
 *
 * <p>
 * Spec §2.3 requires every tenant admin to be notified of a new membership application "email +
 * in-app". Only the email existed: an admin could sign in with somebody waiting to be approved
 * and find no badge, no count and nothing in the menu — the sole cue in the whole product was a
 * line INSIDE /admin/members, which you have to already suspect something to go and read. An
 * application could sit for days behind an email nobody opened.
 * </p>
 */

const PROFILE = {
  user_id: "u1", email: "admin@club.test", is_admin: true, tenant_slug: "crusaders",
  full_name: "Club Desk", membership_number: "M-1", photo_url: null, status: "active",
};

const WALLET = { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 100 };

beforeEach(() => {
  // jsdom has no EventSource; BalanceProvider opens one as soon as a session exists.
  vi.stubGlobal("EventSource", class { close() {} addEventListener() {} } as unknown as typeof EventSource);
});

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

function renderChrome() {
  return render(
    <MemoryRouter initialEntries={["/schedule"]}>
      <AuthProvider>
        <ProfileProvider>
          <BalanceProvider>
            <Layout />
          </BalanceProvider>
        </ProfileProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("the in-app half of the new-application notification", () => {
  it("puts the count of waiting applications on the admin's Members tab", async () => {
    const whoami = { ...signIn({ isAdmin: true }), user_id: "u1" };
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/wallet", body: WALLET },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
      { path: "/api/v1/admin/members", body: [memberFixture({ status: "PendingApproval", email_verified: false })] },
    ]);

    renderChrome();

    // Twice over, deliberately: the chrome carries a desktop nav and a mobile one, and an admin
    // on a phone is exactly who is standing at the club desk.
    const badges = await screen.findAllByLabelText("1 membership application awaiting review");
    expect(badges).toHaveLength(2);
    // The number alone is meaningless beside the word "Members", so the sentence is the
    // accessible name and the digit is the decoration.
    expect(badges[0]).toHaveTextContent("1");
  });

  /**
   * The header row, at the width where an admin has five tabs in it.
   *
   * <p>
   * The inline nav switched on at <code>md</code> (768) and the row needs 800. Measured in
   * Chromium against a live stack, signed in as the seeded admin: on <b>all ten</b> routes
   * <code>document.documentElement.scrollWidth</code> was 795 against a 768px viewport, and
   * the gear button — <code>aria-label="Open menu"</code>, the only route to Sign out —
   * ran from x=751 to x=795, so 27 of its 44 pixels were past the right edge. A member,
   * with three tabs, was clean at every width, which is why it survived.
   * </p>
   *
   * <p>
   * Between 768 and 1023 the scrolling tab strip takes over: the same nav, announcing its
   * own overflow, which is what a phone already gets. jsdom applies no Tailwind and
   * computes no layout, so what this holds is the breakpoint decision; the pixels are
   * re-measured in a browser.
   * </p>
   */
  it("does not put the admin's five tabs in a header row that cannot hold them", async () => {
    const whoami = { ...signIn({ isAdmin: true }), user_id: "u1" };
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/wallet", body: WALLET },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
      { path: "/api/v1/admin/members", body: [] },
    ]);

    renderChrome();
    await screen.findAllByRole("link", { name: "Bookings" });

    // The inline nav is off until `lg`, and the strip is on until `lg`. They are two halves
    // of one decision, so both are asserted — a mismatch shows both at once or neither.
    const inline = document.querySelector("header nav:not([aria-label])")!;
    expect(inline.className).toContain("hidden");
    expect(inline.className).toContain("lg:flex");
    expect(inline.className).not.toContain("md:flex");

    const strip = document.querySelector('header nav[aria-label="Sections"]')!;
    expect(strip.className).toContain("lg:hidden");
    expect(strip.className).not.toContain("md:hidden");

    // And the cluster holding the gear cannot end up under the right edge, which is what
    // put it there in the first place.
    //
    // This asserted `shrink-0` on the cluster, and `shrink-0` was the wrong instrument —
    // see the comment on the cluster in `Layout.tsx`. It stopped the nav squeezing the
    // cluster and, at the same time, stopped the cluster from ever being given a width
    // narrow enough to wrap within: measured in Chromium at a 180 px CSS viewport (a 360 px
    // phone at 200 % zoom) the cluster held one 167 px line inside a 148 px box and the gear
    // went off the edge anyway. What holds the rule now is that the ROW wraps — a cluster
    // that does not fit beside the nav takes a line of its own at full width — and that the
    // cluster wraps inside itself, so the gear moves down rather than out.
    const gear = screen.getByRole("button", { name: "Open menu" });
    const cluster = gear.parentElement!.parentElement!;
    expect(cluster.className).toContain("flex-wrap");
    expect(cluster.className).toContain("min-w-0");
    expect(cluster.parentElement!.className).toContain("flex-wrap");
    // A fixed height cannot hold a row that has been allowed to wrap: it would clip the
    // second line instead of growing to it.
    expect(cluster.parentElement!.className).not.toMatch(/\bh-14\b/);
  });

  it("asks for nothing, and shows nothing, for a member who is not an admin", async () => {
    const whoami = { ...signIn({ isAdmin: false }), user_id: "u2", is_admin: false };
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", body: { ...PROFILE, is_admin: false } },
      { path: "/api/v1/wallet", body: WALLET },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    ]);

    renderChrome();

    await screen.findAllByRole("link", { name: "Bookings" });
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith("/api/v1/me/profile"))).toBe(true));
    expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/members"))).toBe(false);
    expect(screen.queryByLabelText(/awaiting review/)).not.toBeInTheDocument();
  });
});
