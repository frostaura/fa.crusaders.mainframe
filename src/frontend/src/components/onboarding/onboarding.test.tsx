import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HowItWorksPage from "../../pages/HowItWorks";
import { WhatsNextCard } from "./WhatsNextCard";
import { ILLUSTRATIONS } from "./Illustrations";
import { stubFetch } from "../../test/harness";
import {
  buttonRow, doorHoldSentence, guideSteps, whatsNextSteps, WHATS_NEXT_DISMISS_KEY,
} from "../../lib/onboardingCopy";

/**
 * Item 16 — the guide, the pushed card, and the three drawings.
 *
 * <p>
 * The rules worth holding are the ones about what the product may CLAIM: a club with no door
 * is never told about one, a number nobody has served is never quoted, and a button label the
 * page has not been given is described rather than invented.
 * </p>
 */

const BOOKING = {
  starts_at: "2099-01-01T17:00:00Z",
  ends_at: "2099-01-01T17:45:00Z",
  court_number: 3,
  door_opens_at: "2099-01-01T16:30:00Z",
  door_closes_at: "2099-01-01T18:05:00Z",
};

function renderCard(props: Partial<Parameters<typeof WhatsNextCard>[0]> = {}) {
  return render(
    <MemoryRouter>
      <WhatsNextCard booking={BOOKING} timezone="Africa/Johannesburg" {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  try { window.localStorage.removeItem(WHATS_NEXT_DISMISS_KEY); } catch { /* nothing stored */ }
});

describe("the club's own button labels", () => {
  it("prints the club's words when the whole map is known", () => {
    const map = ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60"];
    expect(buttonRow(map, "court")).toEqual(["A", "B", "C", "D"]);
    expect(buttonRow(map, "time")).toEqual(["15", "30", "45", "60"]);
    expect(guideSteps({ buttonMap: map }).find((s) => s.id === "box")!.body.join(" "))
      .toMatch(/the green buttons marked A, B, C and D/);
  });

  /**
   * Cross-tenant: the labels come from the club, never from a module-scope constant. A second
   * club that has relabelled its panel must see its own words.
   */
  it("prints a second club's different words", () => {
    const map = ["court:1", "court:2", "court:3", "court:4", "minutes:20", "minutes:40", "minutes:60", "off"];
    const box = guideSteps({ buttonMap: map }).find((s) => s.id === "box")!.body.join(" ");
    expect(box).toMatch(/the green buttons marked 1, 2, 3 and 4/);
    // One slot is `off`, which is not a label. Half a row is not a row, so that half falls
    // back to the keys the box is built with rather than quoting three of four durations —
    // a guide that is wrong about the fourth is worse than one that describes the panel.
    expect(box).toMatch(/the black buttons marked 15, 30, 45 and 60/);
  });

  /**
   * With no map served, the guide names the keys the box is PHYSICALLY built with — four
   * green A B C D over four black 15 30 45 60, confirmed by the devices lane — because that
   * is a description of hardware rather than a guess at a label. What it must never do is
   * invent one, so nothing is ever in quotation marks.
   */
  it.each([
    ["absent", undefined],
    ["null", null],
    ["short", ["court:A", "court:B"]],
    ["all non-labels", ["off", "none", "off", "none", "off", "none", "off", "none"]],
  ])("names the box's own keys when the map is %s", (_why, map) => {
    expect(buttonRow(map as string[] | null | undefined, "court")).toEqual([]);
    const box = guideSteps({ buttonMap: map as string[] | null | undefined }).find((s) => s.id === "box")!;
    const text = box.body.join(" ");
    expect(text).toMatch(/the green buttons marked A, B, C and D/);
    expect(text).toMatch(/the black buttons marked 15, 30, 45 and 60/);
    expect(text).not.toMatch(/"/);
  });

  /** The greeting is the box's own: HI, then the member's name. */
  it("says the box greets you by name", () => {
    const box = guideSteps().find((s) => s.id === "box")!;
    expect(box.body.join(" ")).toMatch(/HI and your name/);
  });
});

describe("the door's unlock dwell", () => {
  /**
   * The dwell is a tenant setting the door's own board is told about on its heartbeat. No
   * member-facing read carries it, so the sentence must not quote the default as though the
   * page had read it.
   */
  it("says 'a few seconds' rather than quoting a number nobody served", () => {
    expect(doorHoldSentence(null)).toMatch(/a few seconds/);
    expect(doorHoldSentence(null)).not.toMatch(/\d/);
  });

  it("quotes the club's own number the day one is served", () => {
    expect(doorHoldSentence(15)).toMatch(/about 15 seconds/);
    expect(doorHoldSentence(25)).toMatch(/about 25 seconds/);
  });
});

describe("a club with no doors", () => {
  it("is never told about one", () => {
    const text = guideSteps({ doors: "no" }).flatMap((s) => [s.title, ...s.body]).join(" ");
    expect(text).not.toMatch(/door/i);
    expect(guideSteps({ doors: "no" }).some((s) => s.id === "door")).toBe(false);
  });

  /** "Unknown" is not "no": a member who HAS a door and is not told is stuck outside. */
  it.each(["yes", "unknown", undefined] as const)("keeps the door step when the answer is %s", (doors) => {
    expect(guideSteps({ doors }).some((s) => s.id === "door")).toBe(true);
  });
});

describe("the guide page", () => {
  it("is a list of sections with a heading each, and no carousel", async () => {
    stubFetch([{ path: "/api/v1/me/door", body: { doors: true, doors_shut: "none" } }]);
    render(<MemoryRouter><HowItWorksPage /></MemoryRouter>);

    const items = await screen.findAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(6);
    // One h2 per step. A member reading instructions must be able to look back at step three
    // without losing step four, which is exactly what a carousel takes away.
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBe(items.length);
    expect(document.querySelector('[data-carousel], [role="tablist"]')).toBeNull();
  });

  it("describes the real flow: scan, then the card, then court, then time", async () => {
    stubFetch([{ path: "/api/v1/me/door", body: { doors: true, doors_shut: "none" } }]);
    render(<MemoryRouter><HowItWorksPage /></MemoryRouter>);
    await screen.findAllByRole("listitem");

    const box = screen.getByRole("heading", { name: /Turn the lights on at the court box/ })
      .closest("li")!.textContent ?? "";
    // The box's own resting words, not an invented caption.
    expect(box).toMatch(/SCAN YOUR CODE/);
    // The asymmetry that is the single most useful thing to tell somebody: a booked member
    // presses nothing, because the panel has no OK button.
    expect(box).toMatch(/lights come on by themselves/);
    expect(box).toMatch(/there is nothing to press/);
    // And the two presses a walk-up makes, in order.
    expect(box.indexOf("court you want")).toBeLessThan(box.indexOf("how long you want it"));
  });
});

describe("the three drawings", () => {
  it.each(Object.entries(ILLUSTRATIONS))("%s is an image with a real name", (_key, Drawing) => {
    const { container } = render(<Drawing />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(20);
    expect(svg.querySelector("title")?.textContent?.length ?? 0).toBeGreaterThan(5);
    /*
      Stroke-first in `currentColor`. `forced-colors: active` throws every author fill away,
      so a drawing that carries its shape in fills collapses to nothing — which is what the
      home page's own motif does, and the one thing corrected here.
    */
    const stroked = svg.querySelectorAll('[stroke="currentColor"], .stroke-current');
    expect(stroked.length).toBeGreaterThanOrEqual(2);
    cleanup();
  });
});

describe("the what-happens-next card", () => {
  it("names the real court and the real times, in the club's day", () => {
    renderCard();
    // 17:00Z is 19:00 in Johannesburg. The club's zone, not the reader's, and 24-hour.
    expect(screen.getByText(/court 3, from 19:00 to 19:45/i)).toBeInTheDocument();
    expect(screen.queryByText(/PM/)).toBeNull();
  });

  it("says nothing at all without a booking", () => {
    const { container } = renderCard({ booking: null });
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the door line out of a club that has none", () => {
    renderCard({ doors: "no" });
    expect(document.body.textContent).not.toMatch(/door/i);
  });

  /**
   * Dismissal is per BOOKING, stored as that booking's own end instant, so it re-arms by
   * itself for the next one. The mutant this kills is storing a flag: a member who dismissed
   * it once would never be shown it again, including for the booking they make next month.
   */
  it("stays dismissed for this booking and comes back for the next", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/court 3, from 19:00/i)).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEXT_DISMISS_KEY)).toBe(BOOKING.ends_at);

    cleanup();
    renderCard();
    expect(screen.queryByText(/court 3, from 19:00/i)).toBeNull();

    cleanup();
    const later = { ...BOOKING, starts_at: "2099-01-02T17:00:00Z", ends_at: "2099-01-02T17:45:00Z", court_number: 1 };
    renderCard({ booking: later });
    expect(screen.getByText(/court 1, from 19:00 to 19:45/i)).toBeInTheDocument();
  });

  /** Storage the browser has taken away is not a reason for the card to throw. */
  it("survives a browser that refuses storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    // Dismissed for this visit even though nothing could be written down.
    expect(screen.queryByText(/court 3, from 19:00/i)).toBeNull();
  });

  /** It is a standing card on a screen somebody arrived at, never a second announcement. */
  it("raises no live region of its own", () => {
    renderCard();
    expect(document.querySelectorAll("[aria-live], [role=status], [role=alert]")).toHaveLength(0);
  });

  it("puts the guide one tap away", () => {
    renderCard();
    expect(screen.getByRole("link", { name: /Read the whole guide/ })).toHaveAttribute("href", "/how-it-works");
  });

  it("builds one line per thing that happens, and no more", () => {
    const lines = whatsNextSteps(
      { courtNumber: 2, startsClock: "19:00", endsClock: "19:45" },
      { doors: "yes" },
    );
    expect(lines).toHaveLength(5);
    expect(lines.every((line) => line.trim().length > 0)).toBe(true);
  });
});
