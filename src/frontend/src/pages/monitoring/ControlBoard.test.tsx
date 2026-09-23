import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { ControlBoardPage } from "./ControlBoard";
import { renderPage, SETTINGS_FIXTURE, signIn, stubFetch, type StubRoute } from "../../test/harness";
import { boardCourtFixture, boardFixture, EVENING } from "../../test/monitoringFixtures";
import type { ControlBoardView } from "../../lib/adminApi";

/**
 * The Control Board, held to what it is allowed to claim.
 *
 * <p>
 * This page goes on a tablet screwed to a wall in a squash club. The failure that matters is
 * not that it looks wrong — it is that it looks RIGHT while saying something the software
 * cannot know, because nobody checks a screen that looks fine. So the cases below are almost
 * all refusals: what it does not say when the box has gone quiet, what it does not claim when
 * the API has not shipped a field, and what it does not stop saying when the club cannot be
 * reached.
 * </p>
 *
 * <p>
 * The wall-view preference lives in `localStorage`, which `src/test/setup.ts` backs with an
 * in-memory store shared across a file — so it is cleared between cases here rather than
 * leaking one test's tablet setting into the next.
 * </p>
 */

const routes = (view: ControlBoardView | null, extra: StubRoute[] = []): StubRoute[] => [
  { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
  { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
  ...(view ? [{ path: "/api/v1/admin/control-board", body: view } as StubRoute] : []),
  // The stream ticket is refused throughout, which is the honest default for a jsdom run:
  // `setup.ts` installs an inert EventSource that connects to nothing, so a test that let the
  // ticket succeed would be asserting against a stream that can never deliver a frame.
  { method: "POST", path: "/api/v1/admin/control-board/stream-ticket", status: 503, body: {} },
  ...extra,
];

describe("the control board", () => {
  beforeEach(() => {
    signIn({ isAdmin: true });
    try { window.localStorage.clear(); } catch { /* see setup.ts */ }
  });
  afterEach(() => { vi.useRealTimers(); });

  it("shows each court's state as a WORD, not as a colour", async () => {
    stubFetch(routes(boardFixture()));
    renderPage(<ControlBoardPage />);

    // A colour-blind admin eight feet from a tablet reads this; under forced colours the
    // fills are discarded entirely and the word is all that survives.
    expect(await screen.findByText("SHOULD BE LIT")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Court 2", level: 2 })).toBeInTheDocument();
  });

  /**
   * The honesty rule, on the page rather than in the copy module: the tile may say the lights
   * are on ONLY because the server said its own reading was not stale.
   */
  it("says the box confirmed it, when the BOX confirmed it", async () => {
    const court = boardCourtFixture();
    stubFetch(routes(boardFixture({
      courts: [{ ...court, lights: { ...court.lights!, confirmed_at: court.lights!.as_of, confirmed_state: "on" } }],
    })));
    renderPage(<ControlBoardPage />);
    expect(await screen.findByText(/confirmed by the box at 18:00/)).toBeInTheDocument();
  });

  /**
   * And NOT when only the server's own record is recent. `stale: false` is a fact about the
   * activation the API granted, not about a relay — every board in the field reports no relay
   * state until the new firmware ships, so reading it as confirmation would have printed
   * "confirmed by the box" across a whole club on day one.
   */
  it("does not manufacture confirmation out of the server's own freshness", async () => {
    stubFetch(routes(boardFixture()));
    renderPage(<ControlBoardPage />);

    expect(await screen.findByText(/No box has confirmed it\./)).toBeInTheDocument();
    expect(screen.queryByText(/confirmed by the box/)).not.toBeInTheDocument();
  });

  it("will not assert a relay it has not heard about", async () => {
    const court = boardCourtFixture();
    stubFetch(routes(boardFixture({
      courts: [{ ...court, lights: { ...court.lights!, stale: true } }],
    })));
    renderPage(<ControlBoardPage />);

    expect(await screen.findByText(/nothing has confirmed it/)).toBeInTheDocument();
    expect(screen.queryByText(/confirmed by the box/), "an unqualified claim on a wall")
      .not.toBeInTheDocument();
  });

  /**
   * <b>The mutant this kills is the one the whole release is exposed to.</b> Three backend
   * lanes are building this payload in parallel. On the day this screen ships ahead of
   * `lights.stale`, reading the absent field as `false` would print "confirmed by the box"
   * over a reading that nothing has confirmed — the screen manufacturing certainty out of a
   * gap, on a wall, in a club.
   */
  it("claims neither freshness nor staleness for a field the API has not shipped", async () => {
    const court = boardCourtFixture();
    const lights = { ...court.lights! };
    delete (lights as Record<string, unknown>).stale;
    stubFetch(routes(boardFixture({ courts: [{ ...court, lights }] })));
    renderPage(<ControlBoardPage />);

    expect(await screen.findByText("The club's records say the lights went on at 18:00."))
      .toBeInTheDocument();
    expect(screen.queryByText(/confirmed by the box/)).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing has confirmed it/)).not.toBeInTheDocument();
    // And not even the "no box has confirmed it" clause: with `stale` absent this arm makes
    // no claim in EITHER direction, which is the whole of what a third arm is for.
    expect(screen.queryByText(/No box has confirmed it/)).not.toBeInTheDocument();
  });

  it("goes UNKNOWN for a court whose box is silent, and names the court rather than counting it", async () => {
    const court = boardCourtFixture();
    stubFetch(routes(boardFixture({
      courts: [{ ...court, device: { ...court.device!, link: "offline" } }],
    })));
    renderPage(<ControlBoardPage />);

    expect(await screen.findByText("UNKNOWN")).toBeInTheDocument();
    expect(screen.queryByText("SHOULD BE LIT"), "a booking outranking a dead board")
      .not.toBeInTheDocument();
    // "3 of 4 boards reported" sends nobody anywhere. The point of this page to somebody
    // standing in a club is that it says which shelf to walk to.
    expect((await screen.findAllByText(/Court 2's box hasn't called in/)).length).toBeGreaterThan(0);
  });

  it("offers no way to switch a light, and says why in words", async () => {
    stubFetch(routes(boardFixture()));
    renderPage(<ControlBoardPage />);
    await screen.findByText("SHOULD BE LIT");

    // Absent, never disabled. A greyed-out control is a promise the product cannot keep, and
    // this audience will press it and then walk to a dark court.
    const controls = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(controls.some((t) => /light/i.test(t)), "a lights control on a pull-only box").toBe(false);
    expect(screen.getByText(/Lights cannot be switched from here/)).toBeInTheDocument();
  });

  it("says what the board IS, standing, and says it once", async () => {
    stubFetch(routes(boardFixture()));
    renderPage(<ControlBoardPage />);

    await screen.findAllByText(/What the club expects/);
    // `live="standing"` puts no live role on the visible banner — a page that re-reads itself
    // every few seconds would otherwise announce this paragraph on every poll.
    await waitFor(() => expect(
      [...document.querySelectorAll("[aria-live='polite']")].map((n) => n.textContent).join(""),
    ).toMatch(/What the club expects/));
  });

  /**
   * <b>Stale truth beats no truth, on a wall.</b> This is the one place the ordinary
   * failed-before-empty rule bends, and it bends on purpose: what the club last knew is the
   * only information in the building. What is forbidden is showing it unqualified.
   */
  it("keeps the tiles when the club cannot be reached, with a band and a real time", async () => {
    stubFetch(routes(null, [
      /*
        `body: null` beside `sequence` is a harness wart, not a stray key. `stubFetch` rejects
        a route with neither `body` nor `respond` BEFORE it looks at `sequence`, so a
        sequenced route with no body answers every call with a thrown "has neither body nor
        respond" — which reads, from the page, exactly like the club being unreachable. Worth
        an hour if you do not know; reported to the lane that owns the harness.
      */
      { path: "/api/v1/admin/control-board", body: null, sequence: [boardFixture(), { error: "boom" }], status: [200, 500] },
    ]));
    renderPage(<ControlBoardPage />);
    await screen.findByText("SHOULD BE LIT");

    // R3: Refresh is the header's icon button now, found by its name rather than its text.
    screen.getByRole("button", { name: "Refresh" }).click();

    await screen.findAllByText(/Can't reach the club\. What you can see below was read at \d\d:\d\d/);
    expect(screen.getByText("SHOULD BE LIT"), "a wall blanked by one failed poll").toBeInTheDocument();
  });

  it("says a club with no courts has none, rather than looking broken", async () => {
    stubFetch(routes(boardFixture({ courts: [] })));
    renderPage(<ControlBoardPage />);
    expect(await screen.findByText(/no courts set up yet/)).toBeInTheDocument();
  });

  /**
   * The read failed and there is nothing to fall back on. This is the opposite case to the
   * one above and it must NOT render "this club has no courts set up yet" — that would be a
   * claim about the club made out of a fact about the request.
   */
  it("does not invent an empty club out of a failed first read", async () => {
    stubFetch(routes(null, [
      { path: "/api/v1/admin/control-board", status: 500, body: { error: "boom" } },
    ]));
    renderPage(<ControlBoardPage />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/no courts set up yet/)).not.toBeInTheDocument();
  });

  it("states which way it is getting its updates, rather than leaving it to be inferred", async () => {
    stubFetch(routes(boardFixture()));
    renderPage(<ControlBoardPage />);
    await screen.findByText("SHOULD BE LIT");

    // The ticket endpoint is refused in this harness, so the honest answer is the poll —
    // and the page has to say so rather than looking live and being ten seconds behind.
    await waitFor(() => expect(screen.getByTestId("board-freshness").textContent)
      .toMatch(/Re-reading every \d+ seconds|Connecting|Can't reach/));
  });

  it("scales the whole wall from one property when wall view is on", async () => {
    stubFetch(routes(boardFixture()));
    const { container } = renderPage(<ControlBoardPage />);
    await screen.findByText("SHOULD BE LIT");

    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue("--board-scale")).toBe("");
    screen.getByLabelText("Wall view").click();
    await waitFor(() => expect(root.style.getPropertyValue("--board-scale")).toBe("1.6"));
  });

  it("counts down from the clock rather than from its own ticks", async () => {
    // A counter that subtracts one per tick drifts by exactly as much as the browser
    // throttled it — which on a tab that has been in the background for an hour is an hour.
    vi.setSystemTime(new Date(EVENING));
    stubFetch(routes(boardFixture()));
    renderPage(<ControlBoardPage />);

    // 18:00:31 → 18:45:00 is 44 minutes 29 seconds.
    expect(await screen.findByText("44:29")).toBeInTheDocument();
  });

  it("speaks a court once when its state changes, and never on the digits", async () => {
    vi.setSystemTime(new Date(EVENING));
    stubFetch(routes(boardFixture()));
    renderPage(<ControlBoardPage />);
    await screen.findByText("SHOULD BE LIT");

    // The countdown is `aria-hidden`: a live region carrying it would say a number every
    // second, on four courts, for the length of a squash match.
    const digits = screen.getByText("44:29", { exact: false });
    expect(digits).toHaveAttribute("aria-hidden");
    // And the state word too — what speaks is the sentence, only when the word changes.
    expect(screen.getByText("SHOULD BE LIT")).toHaveAttribute("aria-hidden");
  });
});
