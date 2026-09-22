import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthShell } from "./AuthShell";
import { palette } from "@/lib/tokens";

/**
 * <b>The tin rule under the masthead, and why it is worth a test of its own.</b>
 *
 * <p>
 * Every screen a member meets before they have an account — sign in, join, confirm your
 * address, forgot and reset your password, welcome — is this one component, and so is the
 * club's email stationery's masthead. The blue band alone is a blue band. The red line under
 * it is what makes a Crusaders screen recognisably a Crusaders screen, and it exists in both
 * places so that an email and a screen do not look like two different clubs.
 * </p>
 *
 * <p>
 * It is pinned rather than left to the eye because it is exactly the kind of mark that
 * disappears in a refactor without anybody noticing: it carries no text, it has no role, no
 * test asserts on it, and a screenshot of a page without it still looks perfectly fine. The
 * colour is asserted from the palette rather than restated as a hex, so the one place it can
 * be changed is <code>tokens.ts</code>.
 * </p>
 */
describe("AuthShell", () => {
  it("draws the club's tin rule under the blue masthead", () => {
    const { container } = render(<AuthShell subline="Court bookings, credits and your club account.">
      <p>form</p>
    </AuthShell>);

    const rule = container.querySelector(".bg-brand-tin");
    expect(rule, "the masthead has lost its tin rule").not.toBeNull();

    // Decorative: it says nothing a screen reader has any use for, and a rule that announced
    // itself would be noise on every auth screen in the product.
    expect(rule!.getAttribute("aria-hidden")).toBe("true");
    expect(rule!.textContent).toBe("");
  });

  /**
   * The colour itself, from the palette. `bg-brand-tin` resolves through Tailwind from
   * `palette.brand.tin`, and this is what stops somebody "tidying" that entry to a different
   * red while the email stationery — which hard-codes the same value, because an email client
   * has never heard of a CSS custom property — quietly keeps the old one.
   */
  it("takes its colour from the brand palette, which the email stationery mirrors", () => {
    expect(palette.brand.tin).toBe("#CF2E30");
  });

  it("still renders the club's name and the subline it was given", () => {
    render(<AuthShell subline="Apply for a member account. It takes a minute."><p>form</p></AuthShell>);
    expect(screen.getByText("Crusaders Squash Club")).toBeInTheDocument();
    expect(screen.getByText("Apply for a member account. It takes a minute.")).toBeInTheDocument();
  });
});
