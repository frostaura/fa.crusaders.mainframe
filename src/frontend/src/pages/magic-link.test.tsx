import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import WelcomePage from "./Welcome";
import VerifyEmailPage from "./VerifyEmail";
import { AuthProvider } from "../lib/auth";
import { signOut, stubFetch } from "../test/harness";

/**
 * The two links a member gets by email are single-use, and the screens that open them were
 * spending them more than once.
 *
 * <p>
 * `/welcome/:token` fired the consume FOUR times — its effect depends on `auth`, which is a new
 * object on every auth state change including the one its own success causes, and StrictMode
 * doubles each run. Three of the four were `400 invalid_or_expired` racing the one that worked,
 * and whichever settled last decided whether the member landed on the schedule or read "This
 * sign-in link has expired." about a link that had just signed them in. `/verify-email/:token`
 * did the same thing twice, from the StrictMode half alone.
 * </p>
 *
 * <p>
 * Counted as CALLS, because that is the defect: the screen may re-render as often as it likes,
 * but a non-idempotent effect on a single-use token may not run twice.
 * </p>
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

const consumed = (calls: { path: string }[], prefix: string) =>
  calls.filter((c) => c.path.startsWith(prefix)).length;

describe("a single-use link is spent exactly once", () => {
  it("consumes the welcome magic link once, not again when the sign-in it caused re-renders the page", async () => {
    const stub = stubFetch([
      {
        method: "POST", path: "/api/v1/auth/magic-link/", status: [200, 400], body: null,
        // The second call is what the API really says to a link already spent — so a test that
        // let it happen would also be reproducing the wrong screen the member saw.
        sequence: [
          { access_token: "member.jwt.value", user_id: "u1", is_admin: false },
          { error: "invalid_or_expired" },
        ],
      },
    ]);

    render(
      <MemoryRouter initialEntries={["/welcome/tok-abc"]}>
        <AuthProvider>
          <Routes>
            <Route path="/welcome/:token" element={<WelcomePage />} />
            <Route path="/schedule" element={<span>Schedule</span>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Schedule")).toBeInTheDocument();
    expect(consumed(stub.calls, "/api/v1/auth/magic-link/")).toBe(1);
    expect(screen.queryByText(/sign-in link has expired/i)).not.toBeInTheDocument();
  });

  it("verifies an email address once even under StrictMode's double-invoke", async () => {
    const stub = stubFetch([
      {
        method: "POST", path: "/api/v1/auth/verify-email/", status: [200, 400], body: null,
        sequence: [{ verified: true }, { error: "invalid_or_expired" }],
      },
    ]);

    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/verify-email/tok-xyz"]}>
          <Routes>
            <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );

    expect(await screen.findByRole("heading", { name: /Email verified/i })).toBeInTheDocument();
    expect(consumed(stub.calls, "/api/v1/auth/verify-email/")).toBe(1);
  });
});
