import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { useEffect } from "react";
import LoginPage from "./Login";
import { RequireAuth } from "../App";
import { FirstRunGate } from "../components/onboarding/FirstRunGate";
import { ProfileProvider } from "../lib/profile";
import { api as client } from "../lib/api";
import { LOGIN } from "../lib/authCopy";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * R1 (F3 follow-up) — an admin's session lapses mid-save on /admin/settings; they sign back in.
 * The page they were on must win over the first-run wizard for the SAME member: the settings
 * page restores its kept draft there, and "Step 1 of 8" would strand it.
 */
function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

/** Stands in for a Settings save refused because the session lapsed. */
let saved = false;
function SavingSettings() {
  // Once: the first mount's save is the one the lapse refuses; the page after sign-in only reads.
  useEffect(() => { if (!saved) { saved = true; void client.put("/api/v1/admin/settings", {}).catch(() => undefined); } }, []);
  return <Where />;
}

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); sessionStorage.clear(); });

describe("signing back in after a lapse", () => {
  it("returns to the page the session lapsed on, not to the wizard", async () => {
    const whoami = signIn({ isAdmin: true });
    let saves = 0;
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", body: {
        user_id: whoami.user_id, email: "a@club.test", is_admin: true, tenant_slug: "crusaders", full_name: "Ann Admin",
        membership_number: "M-1", photo_url: null, status: "active",
        preferences: { member_onboarding_completed_at: null, member_onboarding_dismissed_at: null, member_onboarding_last_step: null,
          admin_onboarding_completed_at: null, onboarding_version: 1, current_onboarding_version: 1 },
      } },
      { method: "PUT", path: "/api/v1/admin/settings", respond: () => { saves += 1; return { error: "invalid_token" }; }, status: 401 },
      { method: "POST", path: "/api/v1/auth/refresh", status: 401, body: { error: "session_ended" } },
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t2", user_id: whoami.user_id, is_admin: true } },
      { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 10 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    ]);
    renderPage(
      <ProfileProvider>
        <FirstRunGate />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/admin/settings" element={<RequireAuth admin><SavingSettings /></RequireAuth>} />
          <Route path="/my-code" element={<Where />} />
          <Route path="/get-started" element={<Where />} />
        </Routes>
      </ProfileProvider>,
      { initialEntries: ["/admin/settings"] },
    );

    fireEvent.change(await screen.findByLabelText(LOGIN.email), { target: { value: "a@club.test" } });
    expect(saves).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(LOGIN.password), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: LOGIN.submit }));

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/admin/settings"));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/settings");
  });
});

/**
 * The measured case. The admin had signed in through the FORM in this tab, and a sign-in never
 * recorded the confirmed member (only the boot probe did) — so the device still named whoever had
 * been confirmed on it before, the lapse was filed as THAT member's, and the return-to was refused
 * to the admin as "somebody else's page": the landing, and the wizard on it.
 */
describe("signing back in after a lapse, on a device another member used before", () => {
  it("still returns to the admin's page", async () => {
    localStorage.setItem("crusaders.mainframe.last-identity", "99999999-9999-9999-9999-999999999999");
    const admin = "11111111-2222-3333-4444-555555555555";
    saved = false;
    stubFetch([
      { path: "/api/v1/whoami", body: { tenant_slug: "crusaders", tenant_id: "t", user_id: admin, is_authenticated: true, is_admin: true } },
      { path: "/api/v1/me/profile", body: {
        user_id: admin, email: "a@club.test", is_admin: true, tenant_slug: "crusaders", full_name: "Ann Admin",
        membership_number: "M-1", photo_url: null, status: "active",
        preferences: { member_onboarding_completed_at: null, member_onboarding_dismissed_at: null, member_onboarding_last_step: null,
          admin_onboarding_completed_at: null, onboarding_version: 1, current_onboarding_version: 1 },
      } },
      { method: "PUT", path: "/api/v1/admin/settings", status: 401, body: { error: "invalid_token" } },
      { method: "POST", path: "/api/v1/auth/refresh", status: 401, body: { error: "session_ended" } },
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t2", user_id: admin, is_admin: true } },
      { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 10 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    ]);
    renderPage(
      <ProfileProvider>
        <FirstRunGate />
        <Link to="/admin/settings">Open settings</Link>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/admin/settings" element={<RequireAuth admin><SavingSettings /></RequireAuth>} />
          <Route path="/my-code" element={<Where />} />
          <Route path="/get-started" element={<Where />} />
        </Routes>
      </ProfileProvider>,
      { initialEntries: ["/login"] },
    );
    const signInOnce = async () => {
      fireEvent.change(await screen.findByLabelText(LOGIN.email), { target: { value: "a@club.test" } });
      fireEvent.change(screen.getByLabelText(LOGIN.password), { target: { value: "pw" } });
      fireEvent.click(screen.getByRole("button", { name: LOGIN.submit }));
    };
    await signInOnce();
    await screen.findByTestId("where");
    fireEvent.click(screen.getByRole("link", { name: "Open settings" }));
    // The save lapses; the session ends; /login again.
    await signInOnce();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/admin/settings"));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/settings");
  });
});
