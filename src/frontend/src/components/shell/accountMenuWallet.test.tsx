import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import Layout from "./AppShell";
import { ProfileProvider } from "../../lib/profile";
import { ThemeProvider } from "../../lib/theme";
import { renderPage, signIn, signOut, stubFetch } from "../../test/harness";

/**
 * R6 X6-2 — the account menu's Wallet row (shown when the minutes chip has folded away at large
 * text, V5-4) is heard in words: "Wallet 1 hour 30 minutes", never "1 h 30 min".
 */

const realCheck = HTMLElement.prototype.checkVisibility;

afterEach(() => {
  signOut();
  localStorage.clear();
  HTMLElement.prototype.checkVisibility = realCheck;
});

describe("the account menu's Wallet row", () => {
  it("says the balance in spoken words", async () => {
    // The chip's slot is in the bar but not drawn — the one case the row is offered.
    HTMLElement.prototype.checkVisibility = () => false;
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_minutes: 90, entries: [], count: 0 } },
      { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "naledi@sample.local", full_name: "Naledi Dube", photo_url: null, membership_number: "C-104" } },
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
    // Let the balance land before the menu reads it.
    await screen.findByRole("link", { name: /^Wallet balance/ });
    fireEvent.keyDown(await screen.findByRole("button", { name: "Account menu" }), { key: "Enter" });
    const item = await screen.findByRole("menuitem", { name: /^Wallet/ });
    expect(item).toHaveAccessibleName("Wallet 1 hour 30 minutes");
  });
});
