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
