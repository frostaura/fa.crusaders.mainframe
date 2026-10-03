import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "./auth";
import { useAuth } from "./useAuth";
import { ProfileProvider } from "./profile";
import { useProfile } from "./useProfile";
import { signIn, signOut, stubFetch } from "../test/harness";

/**
 * D2 — the profile follows WHO is signed in, not merely WHETHER somebody is.
 *
 * <p>
 * Measured in a headed walk: a leftover token for a member who no longer existed read
 * `/me/profile` once (404); a password sign-in a moment later moved the user id but not the
 * status ("authenticated" → "authenticated"), so the read never ran again. The avatar said "YA",
 * no photo, and the first-run wizard never fired.
 * </p>
 */

const STALE = "44444444-4444-4444-4444-444444444444";
const OLIVIA = "66666666-6666-6666-6666-666666666666";
const OLIVIA_PROFILE = {
  user_id: OLIVIA, email: "olivia@club.review.test", is_admin: false, tenant_slug: "crusaders",
  full_name: "Olivia Newton", membership_number: "MEM-2002", photo_url: null, status: "active",
};

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

function Probe() {
  const auth = useAuth();
  const { profile, failed } = useProfile();
  return (
    <>
      <output data-testid="who">{profile?.full_name ?? "none"}</output>
      <output data-testid="failed">{String(failed)}</output>
      <button type="button" onClick={() => void auth.login("olivia@club.review.test", "pw")}>sign in</button>
    </>
  );
}

describe("ProfileProvider — identity-scoped", () => {
  it("re-reads the profile when a sign-in changes who is signed in, and calls the stale 404 a failure", async () => {
    const whoami = { ...signIn({ isAdmin: false }), user_id: STALE };
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", status: [404, 200], body: null, sequence: [{ error: "not_found" }, OLIVIA_PROFILE] },
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "olivia.token.value", user_id: OLIVIA, is_admin: false } },
    ]);
    render(
      <MemoryRouter>
        <AuthProvider><ProfileProvider><Probe /></ProfileProvider></AuthProvider>
      </MemoryRouter>,
    );

    // The stale identity's read failed — a failure, not "no profile".
    await waitFor(() => expect(screen.getByTestId("failed")).toHaveTextContent("true"));
    expect(screen.getByTestId("who")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "sign in" }));
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("Olivia Newton"));
    expect(screen.getByTestId("failed")).toHaveTextContent("false");
    expect(stub.calls.filter((c) => c.path === "/api/v1/me/profile")).toHaveLength(2);
  });
});
