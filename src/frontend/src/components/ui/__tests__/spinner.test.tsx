import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Spinner } from "../spinner";

describe("Spinner", () => {
  it("is decorative without a label", () => {
    const { container } = render(<Spinner />, { reactStrictMode: true });
    const svg = container.querySelector("[data-slot=spinner]");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is a named status with a label, and stands still under reduced motion", () => {
    render(<Spinner label="Loading bookings" />, { reactStrictMode: true });
    const status = screen.getByRole("status", { name: "Loading bookings" });
    expect(status.getAttribute("class")).toContain("animate-spin");
    expect(status.getAttribute("class")).toContain("motion-reduce:animate-none");
  });
});
