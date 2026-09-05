import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Carousel } from "./Carousel";

/**
 * The two things about this carousel that were measured wrong in a browser.
 *
 * <ol>
 *   <li>Each inactive dot was a <b>6 x 6 px</b> hit target 6px from its neighbour — a quarter of
 *       WCAG 2.2 SC 2.5.8's 24 x 24 — and at 375px the dots are the primary way to move between
 *       chart slides. Keyboard users were fine throughout, which is why only a thumb could find
 *       it.</li>
 *   <li>The Previous arrow occupied x 32-68 while the chart's leftmost y-axis label started at
 *       x 49.9: a 36px opaque button drawn on top of the numbers. It was positioned
 *       <code>left-0 -translate-x-3</code>, which hangs it 12px outside the container and leaves
 *       24px of it inside, over whatever the slide draws there.</li>
 * </ol>
 *
 * <p>
 * jsdom has no layout, so neither measurement can be repeated here — both were taken in
 * Chromium, and after the fix read 24 x 24 and an arrow ending at 68 against a label starting at
 * 89.9. What this file can do is hold the two decisions that produced those numbers, so a class
 * tidied off in a later pass fails here rather than in front of a thumb.
 * </p>
 */

const SLIDES = [
  { key: "a", node: <p>one</p> },
  { key: "b", node: <p>two</p> },
  { key: "c", node: <p>three</p> },
];

describe("carousel controls", () => {
  it("gives every dot a 24px hit target around its 6px pill", () => {
    render(<Carousel slides={SLIDES} />);
    const dots = screen.getAllByTestId("carousel-dot");
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(dot.className).toContain("w-6");
      expect(dot.className).toContain("h-6");
      // The pill is a child, so shrinking it does not shrink what a thumb has to hit.
      expect(dot.querySelector("span")).not.toBeNull();
      expect(dot.querySelector("span")!.className).toContain("h-1.5");
    }
  });

  it("marks which slide is showing, for a screen reader as well as by eye", () => {
    render(<Carousel slides={SLIDES} />);
    const dots = screen.getAllByTestId("carousel-dot");
    expect(dots[0]).toHaveAttribute("aria-current", "true");
    expect(dots[1]).not.toHaveAttribute("aria-current");
  });

  it("keeps the arrows out of the slide rather than on top of it", () => {
    const { container } = render(<Carousel slides={SLIDES} />);
    const previous = screen.getByRole("button", { name: "Previous" });
    const next = screen.getByRole("button", { name: "Next" });
    // No outward translate: that is what put a quarter of the button inside the slide.
    expect(previous.className).not.toMatch(/translate-x-/);
    expect(next.className).not.toMatch(/translate-x-/);

    // And the slide area is inset by the arrows' own width where the arrows are shown.
    const scroller = container.querySelector(".snap-x");
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain("md:mx-10");
  });
});
