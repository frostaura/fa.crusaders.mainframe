import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ProfilePage from "./Profile";
import { AuthProvider } from "../lib/auth";
import { ProfileProvider } from "../lib/profile";
import { ToastProvider } from "../components/Toast";
import { refuse, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";

/**
 * The profile's read states (R12) and its page anatomy (R11).
 *
 * <p>
 * It opened on "Loading…" in a bare card, answered a failed read with "Couldn't load profile."
 * and nothing to press, and its passkey list swallowed its own failure — `catch { non-blocking }`
 * over a list initialised to `[]` — so a member whose read failed was told "No passkeys yet".
 * An empty collection is not an answer: these hold the three states apart.
 * </p>
 */
const PROFILE = {
  user_id: "u1", email: "ada@club.review.test", is_admin: false, tenant_slug: "crusaders",
  full_name: "Ada Lovelace", membership_number: "MEM-1001", photo_url: null, status: "active",
};

function renderProfile(routes: StubRoute[]) {
  const whoami = signIn({ isAdmin: false });
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/me/door", body: { doors: false } },
    ...routes,
  ]);
  render(
    <MemoryRouter>
      <AuthProvider>
        <ProfileProvider>
          <ToastProvider><ProfilePage /></ToastProvider>
        </ProfileProvider>
      </AuthProvider>
    </MemoryRouter>,
    { reactStrictMode: true },
  );
  return stub;
}

/** A browser that can make passkeys — jsdom cannot, so the card would show its unsupported note. */
function withPasskeys() {
  vi.stubGlobal("PublicKeyCredential", class {});
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { create: () => Promise.resolve(null), get: () => Promise.resolve(null) },
  });
}

describe("Profile — reading, failing and the page's shape", () => {
  beforeEach(() => withPasskeys());
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "credentials");
    signOut();
  });

  it("is one page shell: a single h1, and each part a named section", async () => {
    renderProfile([
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);
    await screen.findByLabelText("Full name");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Profile");
    for (const name of ["Your details", "Password", "Passkeys"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
    // R10: the guide is navigation, so it is a link.
    expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute("href", "/how-it-works");
  });

  it("shows its own shape while the profile is read, never Loading…", async () => {
    let answer: (() => void) | null = null;
    renderProfile([
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/me/profile")
      ? new Promise<void>((resolve) => { answer = resolve; }).then(() => realFetch(input, init))
      : realFetch(input, init)));

    await waitFor(() => expect(document.querySelector("[data-state-block=loading][aria-busy=true]")).not.toBeNull());
    expect(screen.queryByText(/Loading…/)).not.toBeInTheDocument();
    await waitFor(() => expect(answer).not.toBeNull());
    answer!();
    expect(await screen.findByLabelText("Full name")).toHaveValue("Ada Lovelace");
  });

  it("says a failed profile read failed, and the retry is a real one", async () => {
    let fail = true;
    renderProfile([
      { path: "/api/v1/me/profile", respond: () => (fail ? refuse(429, { error: "rate_limited" }) : PROFILE) },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);
    const retry = await screen.findByRole("button", { name: "Try again" }, { timeout: 3000 });
    expect(screen.getByText(/Couldn't load your profile/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Full name")).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByLabelText("Full name")).toHaveValue("Ada Lovelace");
  });

  it("never answers a failed passkey read with 'No passkeys yet'", async () => {
    let fail = true;
    renderProfile([
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", respond: () => (fail ? refuse(429, { error: "rate_limited" }) : []) },
    ]);
    const passkeys = await screen.findByRole("region", { name: "Passkeys" });
    const retry = await within(passkeys).findByRole("button", { name: "Try again" });
    expect(within(passkeys).queryByText("No passkeys yet")).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(retry);
    // Now the read answered, and the answer really is "none".
    expect(await within(passkeys).findByText("No passkeys yet")).toBeInTheDocument();
  });

  it("lists the passkeys it has, each with its dates and a way to remove it", async () => {
    renderProfile([
      { path: "/api/v1/me/profile", body: PROFILE },
      {
        path: "/api/v1/me/webauthn/credentials",
        body: [{ id: "k1", label: "iPhone", created_at: "2026-09-01T08:00:00Z", last_used_at: null, transports: "internal" }],
      },
    ]);
    const passkeys = await screen.findByRole("region", { name: "Passkeys" });
    expect(await within(passkeys).findByText("iPhone")).toBeInTheDocument();
    expect(within(passkeys).getByText(/Never used/)).toBeInTheDocument();
    expect(within(passkeys).getByRole("button", { name: /Remove/ })).toBeInTheDocument();
  });

  it("saves a name with a real pending state, not a disabled button", async () => {
    let answer: (() => void) | null = null;
    renderProfile([
      { path: "/api/v1/me/profile", body: PROFILE },
      { method: "PUT", path: "/api/v1/me/profile", body: { ...PROFILE, full_name: "Ada King" } },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);
    const field = await screen.findByLabelText("Full name");
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (init?.method === "PUT"
      ? new Promise<void>((resolve) => { answer = resolve; }).then(() => realFetch(input, init))
      : realFetch(input, init)));

    fireEvent.change(field, { target: { value: "Ada King" } });
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    await waitFor(() => expect(save).toHaveAttribute("aria-busy", "true"));
    expect(save).not.toBeDisabled();
    await waitFor(() => expect(answer).not.toBeNull());
    answer!();
    await waitFor(() => expect(screen.getByLabelText("Full name")).toHaveValue("Ada King"));
  });
});
