import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import App from "../App";
import LoginPage from "./Login";
import RegisterPage from "./Register";
import ForgotPasswordPage from "./ForgotPassword";
import ResetPasswordPage from "./ResetPassword";
import ChangePasswordPage from "./ChangePassword";
import ProfilePage from "./Profile";
import { ToastProvider } from "../components/Toast";
import { AuthProvider } from "../lib/auth";
import { ProfileProvider } from "../lib/profile";
import { signIn, signOut, stubFetch, type StubRoute } from "../test/harness";

/**
 * The member-facing auth screens.
 *
 * <p>
 * Every case here is a sentence a member was shown that was untrue, missing, or the same as the
 * sentence for a completely different problem — a password complaint for a blank name, an
 * "isn't approved yet" for an approved member, "Try again" for something that could never
 * succeed. The API now carries a stable snake_case code on each refusal; these hold the mapping,
 * because a code with no mapping is exactly as useless to a member as no code at all.
 * </p>
 *
 * <p>
 * `fireEvent`, never `user-event`: it hangs under this jsdom setup.
 * </p>
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

/** Reports where the router ended up, so a navigation is assertable rather than inferred. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>;
}

/** A router that can carry initial history state — which is how `RequireAuth` hands over a deep link. */
function renderAt(ui: ReactElement, entries: Parameters<typeof MemoryRouter>[0]["initialEntries"] = ["/"]) {
  return render(
    <MemoryRouter initialEntries={entries}>
      <AuthProvider>
        <ProfileProvider>
          <ToastProvider>
            {ui}
            <LocationProbe />
          </ToastProvider>
        </ProfileProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const err = (path: string, status: number, body: unknown, method = "POST"): StubRoute =>
  ({ method, path, status, body });

async function signInAs(emailValue: string, passwordValue: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: emailValue } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: passwordValue } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("Login — a 403 is two different problems", () => {
  it("names an unconfirmed email address and offers to send the link again", async () => {
    const stub = stubFetch([
      err("/api/v1/auth/login", 403, { error: "email_not_verified" }),
      { method: "POST", path: "/api/v1/auth/resend-verification", body: { ok: true } },
    ]);
    renderAt(<LoginPage />);
    await signInAs("unverified@club.test", "Password123!");

    expect(await screen.findByText(/haven't confirmed your email address/i)).toBeInTheDocument();
    expect(screen.queryByText(/isn't approved yet/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Resend the confirmation email/i }));
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/auth/resend-verification")).toBe(true));
    expect(stub.calls.at(-1)?.body).toEqual({ email: "unverified@club.test" });
    // Neutral on purpose — the endpoint answers the same for an address it has never seen.
    expect(await screen.findByText(/If that address is registered/i)).toBeInTheDocument();
  });

  it("keeps the not-approved message for a membership that really is pending", async () => {
    stubFetch([err("/api/v1/auth/login", 403, { error: "not_approved", status: "Pending" })]);
    renderAt(<LoginPage />);
    await signInAs("pending@club.test", "Password123!");

    expect(await screen.findByText(/isn't approved yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resend the confirmation email/i })).not.toBeInTheDocument();
  });

  it("says to wait rather than 'sign in failed' when the rate limiter answers", async () => {
    stubFetch([err("/api/v1/auth/login", 429, { error: "too_many_requests" })]);
    renderAt(<LoginPage />);
    await signInAs("someone@club.test", "Password123!");

    expect(await screen.findByText(/Too many sign-in attempts/i)).toBeInTheDocument();
  });
});

describe("Login — the page you actually asked for", () => {
  it("returns to the deep link RequireAuth captured, not /schedule", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t", user_id: "u1", is_admin: false } },
    ]);
    // Exactly the shape `RequireAuth` hands over: `state.from` is a router location.
    renderAt(<LoginPage />, [{ pathname: "/login", state: { from: { pathname: "/wallet", search: "" } } }]);
    await signInAs("member@club.test", "Password123!");

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/wallet"));
  });

  it("refuses an off-site 'from' rather than bouncing the member out of the app", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t", user_id: "u1", is_admin: false } },
    ]);
    renderAt(<LoginPage />, [{ pathname: "/login", state: { from: { pathname: "//evil.example.com" } } }]);
    await signInAs("member@club.test", "Password123!");

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/schedule"));
  });
});

describe("Register — one message per mistake", () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@club.test" } });
    fireEvent.change(screen.getByLabelText("Membership number"), { target: { value: "MEM-1001" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Password123!" } });
    const file = new File(["x"], "me.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Photo of yourself"), { target: { files: [file] } });
  };

  /**
   * Submitted on the form rather than by clicking the button: jsdom leaves a `required` file
   * input's `valueMissing` set even once a File has been assigned to it, so a click is swallowed
   * by constraint validation and nothing under test ever runs. Real browsers do not do this.
   */
  const submit = () => fireEvent.submit(screen.getByRole("button", { name: /Submit application/i }).closest("form")!);

  it("names a taken membership number instead of telling the applicant to try again", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/crusaders/photos/x.png" } },
      err("/api/v1/auth/register", 409, { error: "membership_number_in_use" }),
    ]);
    renderAt(<RegisterPage />);
    fill();
    submit();

    expect(await screen.findByText(/membership number is already registered/i)).toBeInTheDocument();
    expect(screen.queryByText(/Try again\./i)).not.toBeInTheDocument();
  });

  it("does not blame the password for a missing field", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/crusaders/photos/x.png" } },
      err("/api/v1/auth/register", 400, { error: "missing_fields" }),
    ]);
    renderAt(<RegisterPage />);
    fill();
    submit();

    expect(await screen.findByText(/fill in every field/i)).toBeInTheDocument();
    // The password hint under the field says "At least 8 characters." whatever happens; what
    // must not appear is the password *complaint*, which is what every 400 used to produce.
    expect(screen.queryByText(/^Your password must be at least 8 characters/i)).not.toBeInTheDocument();
  });

  it("still names a short password when that is what was wrong", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/crusaders/photos/x.png" } },
      err("/api/v1/auth/register", 400, { error: "password_too_short" }),
    ]);
    renderAt(<RegisterPage />);
    fill();
    submit();

    expect(await screen.findByText(/password must be at least 8 characters/i)).toBeInTheDocument();
  });
});

describe("Forgot password", () => {
  it("sends the request and confirms without saying whether the address exists", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/auth/forgot-password", body: { ok: true } }]);
    renderAt(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "who@club.test" } });
    fireEvent.click(screen.getByRole("button", { name: /Send reset link/i }));

    await waitFor(() => expect(stub.calls[0]?.path).toBe("/api/v1/auth/forgot-password"));
    expect(stub.calls[0]?.body).toEqual({ email: "who@club.test" });
    expect(await screen.findByText(/belongs to an account/i)).toBeInTheDocument();
  });
});

/** The token comes from the path, so the page has to be mounted on its real route to see one. */
function renderResetPassword() {
  return render(
    <MemoryRouter initialEntries={["/reset-password/abc"]}>
      <AuthProvider><ToastProvider>
        <Routes><Route path="/reset-password/:token" element={<ResetPasswordPage />} /></Routes>
      </ToastProvider></AuthProvider>
    </MemoryRouter>,
  );
}

describe("Reset password", () => {
  it("tells the member the link is spent rather than showing a code", async () => {
    stubFetch([err("/api/v1/auth/reset-password", 400, { error: "invalid_or_expired" })]);
    renderResetPassword();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Password123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Set new password/i }));

    expect(await screen.findByText(/expired or has already been used/i)).toBeInTheDocument();
    expect(screen.queryByText(/invalid_or_expired/)).not.toBeInTheDocument();
  });

  it("catches a mistyped confirmation before it reaches the API", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/auth/reset-password", body: { reset: true } }]);
    renderResetPassword();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Password124!" } });
    fireEvent.click(screen.getByRole("button", { name: /Set new password/i }));

    expect(await screen.findByText(/don't match/i)).toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("Change password", () => {
  it("distinguishes a wrong current password from a network failure", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: { ...whoami, must_change_password: true } },
      err("/api/v1/me/password", 400, { error: "current_password_incorrect" }),
    ]);
    renderAt(<ChangePasswordPage />);

    // The forced framing, because whoami says a temporary password is in force.
    expect(await screen.findByLabelText("Temporary password")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "wrong" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Password123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Change password/i }));

    expect(await screen.findByText(/not your current password/i)).toBeInTheDocument();
  });

  it("refuses a 'new' password that is the old one, without asking the server", async () => {
    const whoami = signIn({ isAdmin: false });
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { method: "POST", path: "/api/v1/me/password", body: { changed: true } },
    ]);
    renderAt(<ChangePasswordPage />);

    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Password123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Change password/i }));

    // The field hint says the same thing, so match the error paragraph specifically.
    expect(await screen.findByText(/^Your new password has to be different/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path === "/api/v1/me/password")).toBe(false);
  });
});

describe("Profile — the name rule the server has always had", () => {
  const PROFILE = {
    user_id: "u1", email: "ada@club.test", is_admin: false, tenant_slug: "crusaders",
    full_name: "Ada Lovelace", membership_number: "MEM-1001", photo_url: null, status: "active",
  };

  it("states the minimum and refuses to offer Save for a name the API would reject", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);
    renderAt(<ProfilePage />);

    const field = await screen.findByLabelText("Full name");
    expect(screen.getByText(/At least 2 characters/i)).toBeInTheDocument();

    fireEvent.change(field, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(field, { target: { value: "x" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(field, { target: { value: "Ada L" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("offers somewhere to change the password at all", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);
    renderAt(<ProfilePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Change password" }));
    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
  });
});

/**
 * The guard itself, driven through the real `<App />` router rather than a stand-in — the whole
 * point of both cases is what `RequireAuth` hands to `/login` and where it refuses to let a
 * session go, and a re-implementation in the test would prove nothing about either.
 */
describe("RequireAuth", () => {
  beforeEach(() => {
    // jsdom has no EventSource; BalanceProvider opens one as soon as a session exists.
    vi.stubGlobal("EventSource", class { close() {} addEventListener() {} } as unknown as typeof EventSource);
  });

  it("carries the page you asked for through the sign-in it forced on you", async () => {
    window.history.pushState({}, "", "/wallet");
    stubFetch([
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t", user_id: "u1", is_admin: false } },
      { path: "/api/v1/whoami", body: { ...signIn({ isAdmin: false }), user_id: "u1" } },
      { path: "/api/v1/me/profile", body: { user_id: "u1", email: "a@b.test", is_admin: false, tenant_slug: "crusaders", full_name: "Ada", membership_number: "M-1", photo_url: null, status: "active" } },
      { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [] } },
    ]);
    signOut(); // arrive genuinely signed out, the way a bookmarked link does

    render(<App />);
    await signInAs("member@club.test", "Password123!");

    await waitFor(() => expect(window.location.pathname).toBe("/wallet"));
  });

  it("holds a session carrying an admin-issued temporary password on the change screen", async () => {
    signIn({ isAdmin: false });
    window.history.pushState({}, "", "/schedule");
    stubFetch([
      { path: "/api/v1/whoami", body: { ...signIn({ isAdmin: false }), user_id: "u1", must_change_password: true } },
      { path: "/api/v1/me/profile", body: { user_id: "u1", email: "a@b.test", is_admin: false, tenant_slug: "crusaders", full_name: "Ada", membership_number: "M-1", photo_url: null, status: "active" } },
      { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [] } },
    ]);

    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/change-password"));
    expect(await screen.findByLabelText("Temporary password")).toBeInTheDocument();
  });
});
