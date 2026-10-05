import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { ProfileProvider } from "@/lib/profile";
import { CHECKLIST } from "@/lib/onboardingCopy";
import { renderPage, signIn, signOut, stubFetch, unreachable } from "@/test/harness";
import { SetupChecklist } from "./SetupChecklist";

/**
 * R15 X15-4 — offline (or with the club unreachable) both checklist reads fail. The card went
 * from "1 of 4 done" to "0 of 4 done" with three rows of "Couldn't check just now". It keeps the
 * states it last read on this phone; "Couldn't check" stays for what this phone never read.
 */

const PASSKEY = [{ id: "p", label: "iPhone", transports: null, created_at: "2026-09-01T10:00:00Z", last_used_at: null }];

function profile(userId: string) {
  return { user_id: userId, email: "thandi@review.test", is_admin: false, tenant_slug: "crusaders", full_name: "Thandi Probe", membership_number: "M-9", photo_url: null, status: "active" };
}

function online(wallet: object) {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/me/profile", body: profile(whoami.user_id) },
    { path: "/api/v1/wallet", body: wallet },
    { path: "/api/v1/me/webauthn/credentials", body: PASSKEY },
  ]);
}

function clubUnreachable() {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/me/profile", body: profile(whoami.user_id) },
    unreachable("/api/v1/wallet"),
    unreachable("/api/v1/me/webauthn/credentials"),
  ]);
}

const show = () => renderPage(<ProfileProvider><SetupChecklist /></ProfileProvider>, { initialEntries: ["/my-code"] });

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

describe("the setup checklist keeps its last known states (R15 X15-4)", () => {
  it("one done (passkey), then offline: still 1 of 4, the passkey still added, no 'Couldn't check'", async () => {
    online({ balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 50 });
    const first = show();
    const card = await screen.findByRole("region", { name: CHECKLIST.title });
    await within(card).findByText(CHECKLIST.progress(1, 4));
    first.unmount();
    vi.unstubAllGlobals();

    clubUnreachable();
    show();
    const again = await screen.findByRole("region", { name: CHECKLIST.title });
    await within(again).findByText(CHECKLIST.progress(1, 4));
    expect(within(again).getByRole("link", { name: CHECKLIST.items.passkey.done })).toBeInTheDocument();
    expect(within(again).queryByText(CHECKLIST.unknown)).toBeNull();
  });

  it("two done (passkey, minutes), then offline: still 2 of 4", async () => {
    online({ balance_minutes: 40, entries: [{ id: "1", type: "TopUp" }], total_entries: 1, offset: 0, limit: 50 });
    const first = show();
    await within(await screen.findByRole("region", { name: CHECKLIST.title })).findByText(CHECKLIST.progress(2, 4));
    first.unmount();
    vi.unstubAllGlobals();

    clubUnreachable();
    show();
    const again = await screen.findByRole("region", { name: CHECKLIST.title });
    await within(again).findByText(CHECKLIST.progress(2, 4));
    expect(within(again).getByRole("link", { name: CHECKLIST.items.buy.done })).toBeInTheDocument();
    expect(within(again).getByRole("link", { name: CHECKLIST.items.booking.label })).toBeInTheDocument();
  });

  it("never read on this phone: offline still says it couldn't check", async () => {
    clubUnreachable();
    show();
    const card = await screen.findByRole("region", { name: CHECKLIST.title });
    const row = await within(card).findByRole("link", { name: new RegExp(CHECKLIST.items.passkey.label) });
    expect(row).toHaveTextContent(CHECKLIST.unknown);
  });
});
