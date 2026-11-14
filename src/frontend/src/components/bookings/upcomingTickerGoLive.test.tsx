import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { UpcomingTicker } from "./UpcomingTicker";
import { TICKER } from "@/lib/tickerCopy";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";

/**
 * FM-5 / BM-18g (go-live) — the upcoming-games line moves only when it is wider than its strip, and
 * then carries a Pause a touch screen can press (WCAG 2.2.2). A line that fits is drawn once, still.
 */
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const game = (n: number) => ({
  booking_id: `b${n}`, court_name: `Court ${n}`, starts_at: at(n), ends_at: at(n + 0.5), role: "organiser", status: "booked", players: [],
});

/** One run of the line measures `lineWidth`; the strip it sits in measures `stripWidth`. */
function widths(lineWidth: number, stripWidth: number) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "UL" ? lineWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-ticker-strip") ? stripWidth : 0;
  });
}

function reducedMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
}

async function show(count: number) {
  const whoami = signIn({ isAdmin: false });
  stubFetch([{ path: "/api/v1/whoami", body: whoami }, { path: "/api/v1/me/bookings/upcoming", body: { timezone: "Africa/Johannesburg", items: Array.from({ length: count }, (_, i) => game(i + 1)) } }]);
  renderPage(<UpcomingTicker refreshKey={0} />);
  return screen.findByRole("region", { name: TICKER.label }, { timeout: 4000 });
}

describe("the upcoming-games line (FM-5)", () => {
  it("a line that fits is drawn once and never moves — no copy, no pause", async () => {
    widths(300, 900);
    const line = await show(1);
    expect(within(line).getAllByRole("link")).toHaveLength(1);
    expect(line.querySelectorAll("ul")).toHaveLength(1);
    expect(line).not.toHaveAttribute("data-moving");
    expect(within(line).queryByRole("button")).toBeNull();
  });

  it("a line wider than its strip moves, with a Pause that stops it and lets the member scroll", async () => {
    widths(1400, 600);
    const line = await show(4);
    await waitFor(() => expect(line).toHaveAttribute("data-moving"));
    expect(line.querySelectorAll("ul")).toHaveLength(2);
    expect(line.querySelector(".animate-ticker-scroll")).not.toBeNull();
    const pause = within(line).getByRole("button", { name: TICKER.pause });
    expect(pause).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pause);
    expect(line).not.toHaveAttribute("data-moving");
    expect(line.querySelector(".animate-ticker-scroll")).toBeNull();
    expect(line.querySelectorAll("ul")).toHaveLength(1);
    expect(within(line).getByRole("button", { name: TICKER.play })).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("crusaders.ticker.paused")).toBe("1");
  });

  it("the Pause is remembered on this phone", async () => {
    localStorage.setItem("crusaders.ticker.paused", "1");
    widths(1400, 600);
    const line = await show(4);
    expect(await within(line).findByRole("button", { name: TICKER.play })).toBeInTheDocument();
    expect(line).not.toHaveAttribute("data-moving");
  });

  it("with reduced motion an overflowing line stays still (and needs no Pause)", async () => {
    reducedMotion(true);
    widths(1400, 600);
    const line = await show(4);
    await new Promise((r) => setTimeout(r, 20));
    expect(line).not.toHaveAttribute("data-moving");
    expect(within(line).queryByRole("button")).toBeNull();
  });
});
