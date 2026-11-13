import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import HomePage from "./Home";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";
import { forgetLastKnown } from "../lib/lastKnown";

/**
 * What the public page claims, held against what the product does.
 *
 * <p>
 * This is the one screen in the product written for people who are not signed in, and it is
 * therefore the one screen whose statements nobody in the club is in a position to correct.
 * Three of them were wrong, and each was wrong in a way that costs a visitor something real:
 * </p>
 *
 * <ul>
 * <li><b>The lights.</b> "Your booking turns the court lights on when you arrive, so there is
 * no key to collect and nothing to switch on yourself." No such thing exists. A booking earns
 * a short-lived code; the member holds its QR up to the scanner on the court box, or types the
 * twelve characters. The signed-in home page says exactly that one screen away, and so does
 * /court-code — so this page contradicted the rest of the product, and somebody who believed
 * it would stand on a dark court waiting for it to notice them.</li>
 * <li><b>The hours.</b> "Courts bookable 6:30am – 10pm on weekdays" — the configured day starts
 * at 06:00, and the club is open on SATURDAY, 07:00 to 20:00, which the line omitted. A
 * visitor reading it concluded the courts were shut at the weekend.</li>
 * <li><b>The slices.</b> "fifteen-minute slices" is `slice_minutes`, per-tenant configuration.
 * A club that sets 20 had a public page advertising 15.</li>
 * </ul>
 *
 * <p>
 * The hours and the slice length are both tenant settings that a signed-out page has no
 * endpoint to read, so the fix is not a better number — it is not stating one. These tests
 * pin that, because the tempting edit is always to put the specific figure back.
 * </p>
 */
describe("the public landing page", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetLastKnown(); });

  // FM-8: the page is the generic landing (Home), the parts every club shares, and a club's own.
  const source = [
    join(__dirname, "Home.tsx"),
    join(__dirname, "..", "components", "landing", "LandingParts.tsx"),
    join(__dirname, "..", "clubs", "crusaders", "CrusadersLanding.tsx"),
  ].map((file) => readFileSync(file, "utf8")).join("\n");
  /** Prose only. A comment explaining a retired claim must not read as the claim. */
  const prose = source.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "");

  function renderSignedOut() {
    stubFetch([{ path: "/api/v1/whoami", status: 401, body: { error: "unauthenticated" } }]);
    return renderPage(<HomePage />);
  }

  it("does not claim a booking turns the lights on by itself", async () => {
    renderSignedOut();
    const body = await screen.findByText(/hold your code up to the scanner/i);
    expect(body).toBeInTheDocument();
    expect(prose).not.toMatch(/nothing to switch on yourself/i);
    expect(prose).not.toMatch(/booking turns the court lights on/i);
  });

  it("says the same thing about the lights as the rest of the product", () => {
    // /my-code: "what they hold up to the scanner on the court box". D1 moved My Code's
    // sentences into its copy module, which is where they are read from now.
    const myCode = readFileSync(join(__dirname, "..", "lib", "myCodeCopy.ts"), "utf8");
    expect(myCode).toMatch(/scanner on the court box/i);
    expect(prose).toMatch(/scanner on the court box/i);
  });

  it("states no opening time, because the real one is a tenant setting it cannot read", () => {
    // Any clock time at all in the prose is the defect coming back.
    expect(prose).not.toMatch(/\d{1,2}[:.]\d{2}\s*(am|pm)?\s*[–-]\s*\d{1,2}/i);
    expect(prose).not.toMatch(/6[:.]30\s*am/i);
    expect(prose).not.toMatch(/\bweekdays\b/i);
  });

  it("states no slice length, because that is a tenant setting too", () => {
    expect(prose).not.toMatch(/fifteen-minute|15-minute|\bfifteen minutes\b/i);
  });

  it("does not claim a prize purse is the largest on record", () => {
    // The R25 000 is sourced and stays; the superlative around it was not checkable at all.
    expect(prose).toMatch(/R25 000/);
    expect(prose).not.toMatch(/largest purse|recorded history/i);
  });

  it("attributes the mid-1960s to the parent club, which is whose date it is", async () => {
    renderSignedOut();
    const hero = await screen.findByText(/part of Durban North since the mid-1960s/i);
    // The date has to sit with "Northwood Crusaders Sports Club", not loose in a paragraph
    // headed "Crusaders Squash" where it reads as the squash section's founding.
    expect(hero.textContent).toMatch(/Northwood Crusaders\s+Sports Club/);
  });

  /**
   * R15 retired the signed-in tiles, and the tests that pinned their copy with them.
   *
   * <p>
   * The tiles were a second home screen that repeated the tab bar; a signed-in member now lands
   * on My Code itself. What those tests guarded — the member's code named as theirs rather than
   * the court's, and the door clause said only at a club that has a door and only when that is
   * known — lives on My Code now and is held by its own suite. What is left to hold HERE is that
   * "/" hands a member over rather than showing them the visitor's page.
   * </p>
   */
  describe("for a member", () => {
    function Probe() {
      const { pathname } = useLocation();
      return <output data-testid="at">{pathname}</output>;
    }

    function renderRoot() {
      return renderPage(
        <>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/my-code" element={<h1>Your code</h1>} />
          </Routes>
          <Probe />
        </>,
      );
    }

    it("goes straight to My Code", async () => {
      const session = signIn({ isAdmin: false });
      stubFetch([
        { path: "/api/v1/whoami", body: session },
        { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [] } },
      ]);
      renderRoot();

      expect(await screen.findByRole("heading", { name: "Your code" })).toBeInTheDocument();
      expect(screen.getByTestId("at")).toHaveTextContent("/my-code");
      expect(screen.queryByText(/hold your code up to the scanner/i)).toBeNull();
    });

    it("does not flash the visitor's page while the session is still being confirmed", async () => {
      signIn({ isAdmin: false });
      // whoami never answers: the stored token alone decides where "/" goes.
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
      renderRoot();

      expect(await screen.findByRole("heading", { name: "Your code" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Crusaders Squash/ })).toBeNull();
    });
  });
});
