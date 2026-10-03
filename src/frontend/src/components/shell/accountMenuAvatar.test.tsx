import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import Layout from "./AppShell";
import { ProfileProvider } from "../../lib/profile";
import { ThemeProvider } from "../../lib/theme";
import { renderPage, signIn, signOut, stubFetch } from "../../test/harness";

/**
 * R10 X10-1 (FC10's ask) — with no profile in hand (the read failed, stalled or is offline with
 * nothing kept) the account avatar drew "YA": the initials of the fallback phrase "Your account",
 * which are nobody's. It draws the neutral person glyph instead; initials come back with a name.
 */

afterEach(() => {
  signOut();
  localStorage.clear();
});

function renderShell(profile: { status?: number; body: unknown }) {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_minutes: 90, entries: [], count: 0 } },
    { path: "/api/v1/me/profile", ...profile },
  ]);
  renderPage(
    <ThemeProvider>
      <ProfileProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/my-code" element={<h1>Your code</h1>} />
          </Route>
        </Routes>
      </ProfileProvider>
    </ThemeProvider>,
    { initialEntries: ["/my-code"] },
  );
  return whoami;
}

describe("the account avatar without a profile", () => {
  it("draws the person glyph, never the letters of 'Your account', in the bar and the menu", async () => {
    renderShell({ status: 503, body: { error: "unavailable" } });
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    await waitFor(() => expect(trigger.querySelector("[data-slot=avatar-fallback]")).not.toBeNull());
    const fallback = trigger.querySelector<HTMLElement>("[data-slot=avatar-fallback]")!;
    expect(fallback).not.toHaveTextContent("YA");
    expect(fallback.textContent).toBe("");
    expect(fallback.querySelector("svg")).not.toBeNull();

    fireEvent.keyDown(trigger, { key: "Enter" });
    await screen.findByRole("menuitem", { name: "Profile" });
    const menu = screen.getByRole("menu");
    const identity = menu.querySelector<HTMLElement>("[data-slot=avatar-fallback]")!;
    expect(identity.textContent).toBe("");
    expect(identity.querySelector("svg")).not.toBeNull();
    // The phrase stays as the Identity row's TEXT — words, not initials.
    expect(menu).toHaveTextContent("Your account");
  });

  it("draws the member's initials once the profile has landed", async () => {
    renderShell({ body: { email: "naledi@sample.local", full_name: "Naledi Dube", photo_url: null, membership_number: "C-104" } });
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    await waitFor(() => expect(trigger.querySelector("[data-slot=avatar-fallback]")).toHaveTextContent("ND"));
  });
});
