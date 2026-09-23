import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ProfilePage from "./Profile";
import { AuthProvider } from "../lib/auth";
import { ProfileProvider } from "../lib/profile";
import { ToastProvider } from "../components/Toast";
import { refuse, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";
import { KINDS_ROUTE } from "../components/notifications/fixtures";
import { EMAIL_ALERTS_COPY } from "../lib/notificationsCopy";
import {
  PASSKEY_ADD, PASSKEY_NAME_LABEL, PASSKEY_NAME_MISSING, PHOTO_BAD_TYPE, PHOTO_BUTTON, PHOTO_CHANGE_LABEL,
  passkeyRemoveConsequence,
} from "../lib/profileCopy";

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

  /**
   * P3 — the photo change is discoverable on a phone. The avatar's scrim appeared on hover only,
   * and a phone has no hover, so nothing said the photo could be changed. Now there is a visible
   * button beside it (and a permanent camera badge on it), and a file the club cannot take is
   * refused ON the page, beside the photo, rather than in a four-second toast.
   */
  it("offers a visible way to change the photo, and refuses a wrong file beside it", async () => {
    renderProfile([
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);
    const details = await screen.findByRole("region", { name: "Your details" });
    expect(within(details).getByRole("button", { name: PHOTO_CHANGE_LABEL })).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: PHOTO_BUTTON })).toBeInTheDocument();

    const input = details.querySelector("input[type=file]") as HTMLInputElement;
    const pdf = new File(["x"], "cv.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [pdf] } });
    expect(await within(details).findByText(PHOTO_BAD_TYPE)).toBeInTheDocument();
  });

  /** P3 — a passkey with no name is refused on its field, in words, not by a warning toast. */
  it("asks for a passkey name on the field itself", async () => {
    renderProfile([
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);
    const passkeys = await screen.findByRole("region", { name: "Passkeys" });
    fireEvent.click(await within(passkeys).findByRole("button", { name: PASSKEY_ADD }));
    expect(await within(passkeys).findByText(PASSKEY_NAME_MISSING)).toBeInTheDocument();
    expect(within(passkeys).getByLabelText(PASSKEY_NAME_LABEL)).toHaveAttribute("aria-invalid", "true");
  });

  /** P3 — Remove says what stops working before the second press, and the way out says "Keep it". */
  it("says what removing a passkey stops, before it is removed", async () => {
    renderProfile([
      { path: "/api/v1/me/profile", body: PROFILE },
      {
        path: "/api/v1/me/webauthn/credentials",
        body: [{ id: "k1", label: "iPhone", created_at: "2026-09-01T08:00:00Z", last_used_at: null, transports: "internal" }],
      },
    ]);
    const passkeys = await screen.findByRole("region", { name: "Passkeys" });
    fireEvent.click(await within(passkeys).findByRole("button", { name: /Remove/ }));
    expect(within(passkeys).getByText(passkeyRemoveConsequence("iPhone"))).toBeInTheDocument();
    expect(within(passkeys).getByRole("button", { name: "Keep it — iPhone" })).toBeInTheDocument();
    // Dialog copy rules: never "Tap to confirm" — a keyboard user taps nothing.
    expect(passkeys.textContent).not.toMatch(/Tap to confirm/);
  });
});

describe("Profile — an admin's email alerts (R23)", () => {
  beforeEach(() => withPasskeys());
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "credentials");
    signOut();
  });

  it("gives an admin the same switches Settings has, in a card of their own", async () => {
    const stub = renderProfile([
      { path: "/api/v1/me/profile", body: { ...PROFILE, is_admin: true } },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
      KINDS_ROUTE,
      { method: "PUT", path: "/api/v1/me/preferences", body: { admin_notification_optouts: [] } },
    ]);

    const card = await screen.findByRole("region", { name: EMAIL_ALERTS_COPY.profileTitle });
    expect(within(card).getByText(EMAIL_ALERTS_COPY.description)).toBeInTheDocument();
    const toggle = await within(card).findByRole("switch", { name: "Court box or door stopped reporting" });
    expect(toggle).not.toBeChecked();
    expect(within(card).getByRole("switch", { name: "Suspected forged codes" })).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(toggle);
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT" && c.path === "/api/v1/me/preferences")?.body)
      .toEqual({ admin_notification_optouts: [] }));
    expect(within(card).getByRole("switch", { name: "Court box or door stopped reporting" })).toBeChecked();
  });

  it("shows a member no such card — and never asks for the admin catalogue", async () => {
    const stub = renderProfile([
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
      KINDS_ROUTE,
    ]);

    await screen.findByRole("heading", { level: 1 });
    await screen.findByText(PROFILE.full_name);
    expect(screen.queryByRole("region", { name: EMAIL_ALERTS_COPY.profileTitle })).toBeNull();
    expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/notifications"))).toBe(false);
  });
});
