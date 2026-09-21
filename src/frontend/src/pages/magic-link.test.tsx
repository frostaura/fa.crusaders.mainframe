import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import WelcomePage from "./Welcome";
import VerifyEmailPage from "./VerifyEmail";
import { AuthProvider } from "../lib/auth";
import { signIn, signOut, stubFetch } from "../test/harness";

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

    expect(await screen.findByRole("heading", { name: /Email confirmed/i })).toBeInTheDocument();
    expect(consumed(stub.calls, "/api/v1/auth/verify-email/")).toBe(1);
  });
});

/**
 * N-F9 — what a welcome link that has already been spent leaves the member with.
 *
 * <p>
 * A finder opened Nina's link a second time and got one red sentence in an otherwise empty
 * card: <code>getByRole('button')</code> returned <code>[]</code> and
 * <code>locator('a')</code> returned <code>[]</code> — no controls and no links at all — so
 * the only way on was to know to edit the address bar. The reset-password screen has always
 * offered "Link expired? Request a new one", so the inconsistency was inside the product.
 * </p>
 *
 * <p>
 * The sentence was wrong as well as alone. `ConsumeMagicLinkAsync` filters on
 * <code>UsedAt == null</code> and on the expiry in one query and answers a single
 * <code>invalid_or_expired</code>, so the API cannot tell the two apart — and the repairs
 * differ: a USED link means "you probably already have a session", an EXPIRED one means "ask
 * for a new one". Copy that picks one is guessing.
 * </p>
 */
describe("a welcome link that has already been spent", () => {
  /** Renders /welcome/:token against an API that refuses the token, as it does the second time. */
  function openSpentLink(entry = "/welcome/tok-abc") {
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/auth/magic-link/", status: 400, body: { error: "invalid_or_expired" } },
    ]);
    render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <Routes>
            <Route path="/welcome/:token" element={<WelcomePage />} />
            <Route path="/schedule" element={<span>Schedule</span>} />
            <Route path="/login" element={<span>Sign-in screen</span>} />
            <Route path="/forgot-password" element={<span>Reset screen</span>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    return stub;
  }

  it("offers somewhere to go, rather than one sentence in an empty card", async () => {
    openSpentLink();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // The two counts the finder took, as assertions.
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Email me a reset link" })).toHaveAttribute("href", "/forgot-password");
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("does not claim the link expired when the API cannot tell expired from used", async () => {
    openSpentLink();

    // One code, `invalid_or_expired`, for both — so the copy names both. Naming only expiry
    // sends a member to ask for a new link when what they need is the password they have.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/expired or has already been used/);
    expect(screen.getByText(/Your account is fine — only the link is spent/)).toBeInTheDocument();
  });

  it("sends a member who is already signed in on this device into the club", async () => {
    // The commonest second click is the same person on the same phone, or a mail client that
    // pre-fetched the link. Showing them a refusal about a session they already hold is the
    // dead end wearing a different sentence.
    signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: { ...signIn({ isAdmin: false }), user_id: "u1" } },
      { method: "POST", path: "/api/v1/auth/magic-link/", status: 400, body: { error: "invalid_or_expired" } },
    ]);
    render(
      <MemoryRouter initialEntries={["/welcome/tok-abc"]}>
        <AuthProvider>
          <Routes>
            <Route path="/welcome/:token" element={<WelcomePage />} />
            <Route path="/schedule" element={<span>Schedule</span>} />
            <Route path="/login" element={<span>Sign-in screen</span>} />
            <Route path="/forgot-password" element={<span>Reset screen</span>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Schedule")).toBeInTheDocument();
  });

  it("spends the link once and shows one card under StrictMode's double-invoke", async () => {
    // StrictMode's mount → cleanup → mount has produced two separate defects on this screen
    // already, and this file's own history is one of them: the effect used to fire four times
    // and the three losers reported "expired" about a link that had just worked. The new
    // render-time redirect is a second thing that runs twice, so it is driven twice here.
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/auth/magic-link/", status: 400, body: { error: "invalid_or_expired" } },
    ]);
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/welcome/tok-spent"]}>
          <AuthProvider>
            <Routes>
              <Route path="/welcome/:token" element={<WelcomePage />} />
              <Route path="/schedule" element={<span>Schedule</span>} />
              <Route path="/login" element={<span>Sign-in screen</span>} />
              <Route path="/forgot-password" element={<span>Reset screen</span>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>,
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(consumed(stub.calls, "/api/v1/auth/magic-link/")).toBe(1);
    expect(screen.getAllByRole("link", { name: "Sign in" })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /already been used/ })).toBeInTheDocument();
  });

  it("says which link is incomplete rather than printing 'Missing token.'", async () => {
    render(
      <MemoryRouter initialEntries={["/welcome/"]}>
        <AuthProvider>
          <Routes>
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/login" element={<span>Sign-in screen</span>} />
            <Route path="/forgot-password" element={<span>Reset screen</span>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/incomplete/);
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });
});
