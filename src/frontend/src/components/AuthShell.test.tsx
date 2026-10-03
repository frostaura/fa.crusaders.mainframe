import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthShell } from "./AuthShell";
import { AUTH_BRAND } from "../lib/authCopy";
import { composite, contrastRatio, palette, themes, type ThemeName } from "@/lib/tokens";

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
    const { container } = render(<AuthShell subline="Apply for a member account. It takes a minute."><p>form</p></AuthShell>);
    // On the card's own band — the brand panel beside it (from lg) names the club too.
    const band = container.querySelector<HTMLElement>("[data-auth-subline]")!.closest("div.relative")!.parentElement!;
    expect(within(band).getByText("Crusaders Squash Club")).toBeInTheDocument();
    expect(screen.getByText("Apply for a member account. It takes a minute.")).toBeInTheDocument();
  });

  /**
   * R4 form factor (SPEC 3.17): on a wide shell the club stands beside the card, as a named
   * section. R9 L9-1: "wide" is the shell's own rem box, never a viewport `lg:` — at 1024/1280 with
   * 200 % text the viewport split the screen and the panel ran under the card.
   */
  it("draws the brand panel beside the card when the SHELL is 56rem wide, never by the viewport", () => {
    const { container } = render(<AuthShell subline="Court bookings."><p>form</p></AuthShell>);
    const brand = screen.getByRole("region", { name: AUTH_BRAND.club });
    expect(brand.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "@[56rem]/authshell:flex"]));
    for (const fact of AUTH_BRAND.facts) expect(within(brand).getByText(fact)).toBeInTheDocument();
    const shell = container.querySelector("[data-auth-shell]")!;
    const frame = shell.parentElement!;
    expect(frame).toHaveAttribute("data-full-bleed");
    expect(frame.className).toContain("@container/authshell");
    expect(shell.className).toContain("@[56rem]/authshell:grid-cols-[minmax(0,1fr)_28rem]");
    // No viewport breakpoint decides the layout anywhere in the frame.
    for (const el of [frame, ...Array.from(frame.querySelectorAll("*"))]) {
      expect(String(el.getAttribute("class") ?? ""), el.tagName).not.toMatch(/(^|\s)(lg|xl):(grid-cols|flex|hidden|block|self-center|max-w|pr-)/);
    }
  });

  /**
   * <b>The subline has to be readable on the band in BOTH themes — measured, not eyeballed.</b>
   *
   * <p>
   * It was `text-brand-soft`, and `brand.soft` is a SURFACE role that flips with the theme
   * (navy 100 in light, navy 950 in dark) while the band's `brand.strong` deliberately stays
   * navy at night. In dark it painted "Court bookings, credits and your club account" dark blue
   * on blue — 1.6:1, unreadable. It is now the band's own ink (`brand.ink`, white in both themes)
   * at 85%, composited onto the band here the way a browser paints it.
   * </p>
   */
  it.each<ThemeName>(["light", "dark"])("keeps the subline readable on the band in the %s theme", (theme) => {
    const { container } = render(<AuthShell subline="Court bookings, credits and your club account." />);
    const subline = container.querySelector("[data-auth-subline]")!;
    expect(subline.className).toContain("text-brand-ink/85");
    expect(subline.className).not.toMatch(/text-brand-soft/);

    const { brand } = themes[theme];
    const painted = composite(brand.ink, brand.strong, 0.85);
    expect(contrastRatio(painted, brand.strong)).toBeGreaterThanOrEqual(4.5);
    // And the reason it could not stay: the old ink on the dark band.
    if (theme === "dark") expect(contrastRatio(brand.soft, brand.strong)).toBeLessThan(3);
  });

  it("gives the screen one h1, its lead, and the way to the sibling screen under the card", () => {
    render(
      <AuthShell subline="Welcome to the club." title="Sign in" lead="Pick up where you left off."
        footer={<a href="/register">Register</a>}>
        <p>form</p>
      </AuthShell>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in");
    expect(screen.getByText("Pick up where you left off.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Register" })).toBeInTheDocument();
  });
});
