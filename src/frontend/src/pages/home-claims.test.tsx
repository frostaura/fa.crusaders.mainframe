import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import HomePage from "./Home";
import { renderPage, stubFetch } from "../test/harness";

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
  afterEach(() => vi.unstubAllGlobals());

  const source = readFileSync(join(__dirname, "Home.tsx"), "utf8");
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
    // /court-code: "what they hold up to the scanner on the court box".
    const courtCode = readFileSync(join(__dirname, "CourtCode.tsx"), "utf8");
    expect(courtCode).toMatch(/scanner on the court box/i);
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
});
