import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it as vitestIt, vi } from "vitest";
import { settledIt } from "@/test/settled";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, useLocation } from "react-router-dom";
import { AppRoutes } from "../App";
import { AuthProvider } from "../lib/auth";
import { useAuth } from "../lib/useAuth";
import { TOKEN_KEY, tokenStore } from "../lib/api";
import { LOGIN } from "../lib/authCopy";
import { ProfileProvider } from "../lib/profile";
import { SIGN_OUT_EVERYWHERE_COPY as COPY } from "../lib/profileCopy";
import { ToastProvider } from "../components/Toast";
import { signIn, signOut, stubFetch, type StubRoute } from "../test/harness";


// FM-7: every test here waits for the screen it drew to settle before it ends.
const it = settledIt(vitestIt);

/**
 * D7 and D11, through the REAL `AuthProvider` and the real route map — `RequireAuth` included.
 *
 * <p>
 * The unit test of "Sign out everywhere" mounted `/profile` bare, so nothing raced the page's
 * own `navigate("/login", { state })`. In the app the auth reset re-renders the guarded page
 * first, `RequireAuth` redirects with `{ from }`, and the promised sentence never arrived. And
 * that same captured `from` is what sent the NEXT person to sign in to the previous member's
 * `/profile` (D11).
 * </p>
 */

vi.mock("../components/shell/AppShell", () => ({ default: () => <Outlet /> }));
vi.mock("./MyCode", () => ({ default: () => <h1>my code page</h1> }));
vi.mock("./Wallet", () => ({ default: () => <h1>wallet page</h1> }));

const ADA = "44444444-4444-4444-4444-444444444444";
const BEN = "55555555-5555-5555-5555-555555555555";
const REVOKE = "/api/v1/me/sessions/revoke-all";
const PROFILE = {
  user_id: ADA, email: "ada@club.review.test", is_admin: false, tenant_slug: "crusaders",
  full_name: "Ada Lovelace", membership_number: "MEM-1001", photo_url: null, status: "active",
};

function Probe() {
  const { pathname } = useLocation();
  const auth = useAuth();
  return (
    <>
      <output data-testid="at">{pathname}</output>
      <button type="button" onClick={() => void auth.logout()}>probe sign out</button>
    </>
  );
}

function renderApp(path: string, routes: StubRoute[]) {
  const whoami = signIn({ isAdmin: false });
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/me/door", body: { doors: false } },
    { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
    { method: "POST", path: "/api/v1/auth/logout", status: 204, body: "" },
    ...routes,
  ]);
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <ProfileProvider>
            <ToastProvider>
              <AppRoutes />
              <Probe />
            </ToastProvider>
          </ProfileProvider>
        </AuthProvider>
      </MemoryRouter>
    </StrictMode>,
  );
  return stub;
}

async function signInAs(_who: string) {
  fireEvent.change(await screen.findByLabelText(LOGIN.email), { target: { value: "someone@club.review.test" } });
  fireEvent.change(screen.getByLabelText(LOGIN.password), { target: { value: "correct horse" } });
  fireEvent.click(screen.getByRole("button", { name: LOGIN.submit }));
}

function loginAnswer(userId: string): StubRoute {
  return { method: "POST", path: "/api/v1/auth/login", body: { access_token: "next.token.value", user_id: userId, is_admin: false } };
}

describe("signing out, through the real guard", () => {
  beforeEach(() => { signOut(); localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

  it("D7 — 'Sign out everywhere' lands on /login WITH its sentence, although RequireAuth redirects first", async () => {
    // R4 form factor: the signed-in-devices card is on Profile's Account tab.
    renderApp("/profile?tab=account", [{ method: "POST", path: REVOKE, body: { signed_out: true, passkeys_revoked: false, passkeys_removed: 0 } }]);
    const card = await screen.findByRole("region", { name: COPY.title });
    fireEvent.click(within(card).getByRole("button", { name: COPY.open }));
    const dialog = await screen.findByRole("dialog", { name: COPY.confirmTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.confirm }));

    await waitFor(() => expect(screen.getByTestId("at")).toHaveTextContent("/login"));
    expect(await screen.findByText(COPY.done(false, 0))).toBeInTheDocument();
    expect(screen.queryByText(LOGIN.sessionEnded)).not.toBeInTheDocument();
    expect(tokenStore.get()).toBeNull();
  });

  it("D11 — after a sign-out the next person lands on the landing, not on the last person's /profile", async () => {
    renderApp("/profile?tab=account", [loginAnswer(BEN)]);
    await screen.findByRole("region", { name: COPY.title });
    fireEvent.click(screen.getByRole("button", { name: "probe sign out" }));
    await waitFor(() => expect(screen.getByTestId("at")).toHaveTextContent("/login"));

    await signInAs(BEN);
    await waitFor(() => expect(screen.getByTestId("at")).toHaveTextContent("/my-code"));
  });

  it.each([
    ["the same member signs back in: back to the page they were on", ADA, "/profile"],
    ["somebody else signs in: the landing, never the last member's page", BEN, "/my-code"],
  ])("D11 — after a session is taken away, %s", async (_name, who, landing) => {
    renderApp("/profile?tab=account", [loginAnswer(who)]);
    await screen.findByRole("region", { name: COPY.title });
    // Another tab signed out: this tab's session ends underneath it (an expiry, not a choice).
    localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: TOKEN_KEY, newValue: null }));
    await waitFor(() => expect(screen.getByTestId("at")).toHaveTextContent("/login"));
    expect(await screen.findByText(LOGIN.sessionEnded)).toBeInTheDocument();

    await signInAs(who);
    await waitFor(() => expect(screen.getByTestId("at")).toHaveTextContent(landing));
  });
});
