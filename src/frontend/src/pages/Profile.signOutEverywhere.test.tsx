import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import ProfilePage from "./Profile";
import LoginPage from "./Login";
import { AuthProvider } from "../lib/auth";
import { tokenStore } from "../lib/api";
import { LOGIN } from "../lib/authCopy";
import { importHmacKey } from "../lib/memberCode/hotp";
import { loadMemberCode, saveMemberCode } from "../lib/memberCode/keyStore";
import { ProfileProvider } from "../lib/profile";
import { SIGN_OUT_EVERYWHERE_COPY as COPY } from "../lib/profileCopy";
import { ToastProvider } from "../components/Toast";
import { signIn, signOut, stubFetch, type StubRoute } from "../test/harness";

/**
 * "Sign out everywhere" (member-code §10), from the member's own Profile.
 *
 * <p>
 * The server ends every session the member has — the one that asked included — so a success must
 * end the session HERE without `logout`'s server call (its token is dead), wipe what `logout` wipes
 * (the member code's key above all), and land on `/login` saying what happened rather than the
 * "your session ended" commiseration an expiry gets. A refusal changes nothing: the dialog says
 * why and the member stays signed in.
 * </p>
 */

const REVOKE = "/api/v1/me/sessions/revoke-all";
const PROFILE = {
  user_id: "44444444-4444-4444-4444-444444444444", email: "ada@club.review.test", is_admin: false, tenant_slug: "crusaders",
  full_name: "Ada Lovelace", membership_number: "MEM-1001", photo_url: null, status: "active",
};

function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname}</span>;
}

function renderProfile(routes: StubRoute[]) {
  const whoami = signIn({ isAdmin: false });
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/me/door", body: { doors: false } },
    { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
    ...routes,
  ]);
  render(
    <MemoryRouter initialEntries={["/profile?tab=account"]}>
      <AuthProvider>
        <ProfileProvider>
          <ToastProvider>
            <Routes>
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/login" element={<LoginPage />} />
            </Routes>
            <Where />
          </ToastProvider>
        </ProfileProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return stub;
}

async function openDialog() {
  const card = await screen.findByRole("region", { name: COPY.title });
  fireEvent.click(within(card).getByRole("button", { name: COPY.open }));
  return screen.findByRole("dialog", { name: COPY.confirmTitle });
}

/** Holds the revoke's answer until released, so the pending state can be looked at. */
function holdRevoke() {
  const stubbed = globalThis.fetch;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    (String(input).startsWith(REVOKE) ? gate.then(() => stubbed(input, init)) : stubbed(input, init)));
  return () => release();
}

describe("Profile — sign out everywhere", () => {
  beforeEach(() => { signOut(); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  it("explains what happens, keeps passkeys by default, and has a way out", async () => {
    renderProfile([]);
    const dialog = await openDialog();
    expect(within(dialog).getByText(COPY.confirmBody)).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: COPY.revokePasskeys })).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).getByText(COPY.revokePasskeysHint)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: COPY.confirm })).toBeEnabled();
  });

  it("sends revoke_passkeys:false, shows pending, then ends the session locally and lands on /login saying so", async () => {
    await saveMemberCode({
      key: await importHmacKey(new Uint8Array(32).fill(7)),
      ref: "REF-1", generation: 1, tz: "Africa/Johannesburg", offsetMs: 0, userId: PROFILE.user_id, enrolledAt: 0,
    });
    const stub = renderProfile([{ method: "POST", path: REVOKE, body: { signed_out: true, passkeys_revoked: false, passkeys_removed: 0 } }]);
    const dialog = await openDialog();
    const release = holdRevoke();
    const confirm = within(dialog).getByRole("button", { name: COPY.confirm });
    fireEvent.click(confirm);

    await waitFor(() => expect(confirm).toHaveAttribute("aria-busy", "true"));
    expect(tokenStore.get()).not.toBeNull();
    release();
    // Recorded once the held call reaches the stub.
    await waitFor(() => expect(stub.calls.find((c) => c.path === REVOKE)?.body).toEqual({ revoke_passkeys: false }));

    expect(await screen.findByText(COPY.done(false, 0))).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/login");
    expect(tokenStore.get()).toBeNull();
    // Signed out on purpose, not lost: no commiseration, and no server logout with a dead token.
    expect(screen.queryByText(LOGIN.sessionEnded)).not.toBeInTheDocument();
    expect(stub.calls.some((c) => c.path === "/api/v1/auth/logout")).toBe(false);
    // The phone's code key goes with the session, exactly as on logout.
    await waitFor(async () => expect(await loadMemberCode()).toBeNull());
  });

  it("removes the passkeys when asked, and /login says how many went", async () => {
    const stub = renderProfile([{ method: "POST", path: REVOKE, body: { signed_out: true, passkeys_revoked: true, passkeys_removed: 2 } }]);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("switch", { name: COPY.revokePasskeys }));
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.confirm }));

    await waitFor(() => expect(stub.calls.find((c) => c.path === REVOKE)?.body).toEqual({ revoke_passkeys: true }));
    expect(await screen.findByText(COPY.done(true, 2))).toBeInTheDocument();
    expect(COPY.done(true, 2)).toContain("Your 2 passkeys were removed");
  });

  it("keeps the member signed in on a refusal, with the reason in the dialog", async () => {
    renderProfile([{ method: "POST", path: REVOKE, status: 500, body: { error: "boom" } }]);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.confirm }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(new RegExp(`^Couldn't ${COPY.action}`));
    expect(screen.getByTestId("where")).toHaveTextContent("/profile");
    expect(tokenStore.get()).not.toBeNull();
  });
});
