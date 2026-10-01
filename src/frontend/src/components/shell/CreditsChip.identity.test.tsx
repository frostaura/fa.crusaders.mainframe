import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import { ToastProvider } from "../Toast";
import { CreditsChip } from "./CreditsChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * D1 — the chip while the balance is loading, and across a change of member.
 *
 * <p>
 * Measured right after a password sign-in: a red danger "0.00 cr". The figure was the previous
 * identity's (a leftover token for a member who no longer existed) — the provider was keyed on
 * "is somebody signed in", not on WHO, so it never re-read. And while a figure is loading the
 * chip must say so neutrally: never a zero, never the danger tone.
 * </p>
 */

const STALE = "44444444-4444-4444-4444-444444444444";
const OLIVIA = "66666666-6666-6666-6666-666666666666";
const WALLET = "/api/v1/wallet";

/** The stream never opens here — the reads under test are the HTTP ones. */
const silent: BalanceTransport = { open: () => new Promise(() => {}) };

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

function SignInButton() {
  const auth = useAuth();
  return <button type="button" onClick={() => void auth.login("olivia@club.review.test", "pw")}>sign in</button>;
}

/** Holds every wallet read after the first until released. */
function holdLaterWalletReads() {
  const stubbed = globalThis.fetch;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let seen = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const isWallet = String(input).startsWith(WALLET) && !String(input).includes("stream");
    if (isWallet && seen++ > 0) return gate.then(() => stubbed(input, init));
    return stubbed(input, init);
  });
  return () => release();
}

describe("CreditsChip — loading, and a change of member", () => {
  it("drops the previous identity's zero on sign-in, shows a neutral placeholder while loading, then the new figure", async () => {
    const whoami = { ...signIn({ isAdmin: false }), user_id: STALE };
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: WALLET, body: null, sequence: [
        { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 100 },
        { balance_minutes: 170, entries: [], total_entries: 0, offset: 0, limit: 100 },
      ] },
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "olivia.token.value", user_id: OLIVIA, is_admin: false } },
    ]);
    const release = holdLaterWalletReads();
    const { container } = render(
      <MemoryRouter>
        <AuthProvider>
          <BalanceProvider transport={silent}>
            <ToastProvider><CreditsChip /><SignInButton /></ToastProvider>
          </BalanceProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    const chip = () => container.querySelector("[data-credits-chip]") as HTMLElement;

    // The stale identity's figure.
    await waitFor(() => expect(chip()).toHaveTextContent("0.00"));

    fireEvent.click(screen.getByRole("button", { name: "sign in" }));
    // Loading for the new member: no zero, no danger tone, a placeholder, and a label that says so.
    await waitFor(() => expect(chip()).toHaveAttribute("aria-label", expect.stringMatching(/loading/i)));
    expect(chip()).not.toHaveTextContent("0.00");
    expect(chip().className).not.toMatch(/danger/);
    expect(chip().querySelector("[data-slot='skeleton']")).not.toBeNull();

    release();
    await waitFor(() => expect(chip()).toHaveAttribute("aria-label", expect.stringContaining("170.00 credits")));
    expect(chip().className).not.toMatch(/danger/);
  });
});
