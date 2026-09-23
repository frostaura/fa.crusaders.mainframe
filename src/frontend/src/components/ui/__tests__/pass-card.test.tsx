import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PassCard } from "../pass-card";
import { CountdownRing } from "../countdown-ring";
import { AnimatedAlert, AnimatedCheck } from "../feedback-marks";

const strict = { reactStrictMode: true };

describe("PassCard", () => {
  it("renders every slot in boarding-pass order", () => {
    render(
      <PassCard
        label="Your member pass"
        clubName="Crusaders Squash Club"
        crest={<span>crest</span>}
        memberName="Sam Ndlovu"
        avatar={<span>avatar</span>}
        qr={<svg data-testid="qr" />}
        code="482 913"
        meta={<span>New code in 12 seconds</span>}
        footer={<span>Offline · your code still works</span>}
      />,
      strict,
    );
    const card = screen.getByRole("article", { name: "Your member pass" });
    const band = card.querySelector<HTMLElement>("[data-pass-band]")!;
    expect(within(band).getByText("MEMBER")).toBeInTheDocument();
    expect(within(band).getByText("Crusaders Squash Club").className).toContain("font-display");
    expect(within(band).getByText("Sam Ndlovu")).toBeInTheDocument();
    expect(within(band).getByText("crest")).toBeInTheDocument();
    expect(within(band).getByText("avatar")).toBeInTheDocument();
    expect(band.className).toContain("bg-brand-strong");
    expect(band.className).toContain("text-brand-ink");

    const panel = card.querySelector<HTMLElement>("[data-qr-panel]")!;
    expect(within(panel).getByTestId("qr")).toBeInTheDocument();
    expect(card.querySelector("[data-pass-code]")).toHaveTextContent("482 913");
    expect(card.querySelector("[data-pass-code]")!.className).toContain("font-mono");
    expect(screen.getByText("New code in 12 seconds")).toBeInTheDocument();
    expect(screen.getByText("Offline · your code still works")).toBeInTheDocument();
  });

  it("keeps the QR panel white in every theme and under forced colours", () => {
    document.documentElement.classList.add("dark");
    try {
      render(<PassCard clubName="Crusaders" qr={<svg />} />);
      const panel = document.querySelector<HTMLElement>("[data-qr-panel]")!;
      expect(panel.style.backgroundColor).toBe("rgb(255, 255, 255)");
      expect(panel.className).toContain("forced-color-adjust-none");
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  it("cuts the perforation notches and draws the dashed rule", () => {
    render(<PassCard clubName="Crusaders" qr={<svg />} />);
    const band = document.querySelector<HTMLElement>("[data-pass-band]")!;
    // jsdom drops `mask-image` it cannot parse, so assert the notch through the prefixed twin or
    // the unprefixed property — whichever it kept.
    const mask = band.style.getPropertyValue("mask-image") || band.style.getPropertyValue("-webkit-mask-image");
    expect(mask).toContain("radial-gradient");
    expect(document.querySelector("[data-perforation]")!.className).toContain("border-dashed");
  });

  it("carries no watermark — the pass is on the Never list", () => {
    render(<PassCard clubName="Crusaders" qr={<svg />} />);
    expect(document.querySelector(".wm-glyph, [data-watermark]")).toBeNull();
  });
});

describe("CountdownRing", () => {
  const arc = () => document.querySelector<SVGCircleElement>("[data-ring-arc]")!;

  it("is aria-hidden and shows the whole seconds left", () => {
    render(<CountdownRing periodMs={30_000} remainingMs={12_400} />, strict);
    const ring = document.querySelector<HTMLElement>("[data-countdown-ring]")!;
    expect(ring).toHaveAttribute("aria-hidden", "true");
    expect(ring).toHaveTextContent("13");
  });

  it("empties in proportion to the time gone", () => {
    render(<CountdownRing periodMs={30_000} remainingMs={15_000} size={40} strokeWidth={4} />);
    const circumference = 2 * Math.PI * 18;
    expect(Number(arc().getAttribute("stroke-dasharray"))).toBeCloseTo(circumference, 5);
    expect(Number(arc().getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference / 2, 5);
    expect(arc().getAttribute("class")).toContain("duration-tick");
    expect(arc().getAttribute("class")).toContain("ease-linear");
  });

  it("clamps remaining time into the window", () => {
    const { rerender } = render(<CountdownRing periodMs={30_000} remainingMs={-500} />);
    expect(document.querySelector("[data-countdown-ring]")).toHaveTextContent("0");
    rerender(<CountdownRing periodMs={30_000} remainingMs={90_000} />);
    expect(document.querySelector("[data-countdown-ring]")).toHaveTextContent("30");
    expect(Number(arc().getAttribute("stroke-dashoffset"))).toBeCloseTo(0, 5);
  });

  it("snaps full at a new window instead of sweeping back", () => {
    render(<CountdownRing periodMs={30_000} remainingMs={29_800} />);
    expect(arc().getAttribute("class")).not.toContain("transition");
  });

  it("hides the ring, keeping the number, under reduced motion", () => {
    render(<CountdownRing periodMs={30_000} remainingMs={10_000} />);
    const svg = document.querySelector("[data-countdown-ring] svg")!;
    expect(svg.getAttribute("class")).toContain("motion-reduce:hidden");
  });
});

describe("Feedback marks", () => {
  it.each([
    ["check", AnimatedCheck],
    ["alert", AnimatedAlert],
  ] as const)("the %s is aria-hidden, stroked 1.75 in currentColor, and draws on", (name, Mark) => {
    const { container } = render(<Mark />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("data-glyph", name);
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("stroke-width", "1.75");
    expect(svg).toHaveAttribute("fill", "none");
    expect(svg.getAttribute("class")).toContain("animate-fb-pop");
    const strokes = [...svg.querySelectorAll("circle, path")];
    expect(strokes.length).toBeGreaterThanOrEqual(2);
    for (const stroke of strokes) {
      expect(stroke).toHaveAttribute("pathLength", "24");
      expect(stroke).toHaveAttribute("stroke-dasharray", "24");
      expect(stroke.getAttribute("class")).toContain("animate-fb-draw");
      expect(stroke.getAttribute("class")).toContain("motion-reduce:animate-none");
    }
    // The circle draws first; the inner strokes follow it, invisible until they start.
    const inner = strokes[1] as SVGElement;
    expect(inner.style.animationFillMode).toBe("both");
    expect(inner.style.animationDelay).not.toBe("");
  });

  it("renders the finished mark when not animating", () => {
    const { container } = render(<AnimatedCheck animate={false} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("class")).not.toContain("animate");
    for (const stroke of svg.querySelectorAll("circle, path")) {
      expect(stroke).not.toHaveAttribute("stroke-dasharray");
      expect(stroke.getAttribute("class")).toBeNull();
    }
  });
});
