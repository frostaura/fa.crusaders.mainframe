import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { AdminDoorsPage } from "./AdminDoors";
import { AdminDoorsDetailPage } from "./AdminDoorsDetail";
import { AdminDoorsCardPage } from "./AdminDoorsCard";
import { refreshDoorsView } from "../components/doors/useDoorsChrome";
import {
  SETTINGS_FIXTURE, activityFixture, deviceFixture, doorFixture, doorsServer, refuse, renderPage,
  stubFetch,
} from "../test/harness";

/**
 * The doors surface.
 *
 * <p>
 * <b>Most of the door tests below arrived here from `AdminDevices.test.tsx`</b>, with the
 * controls they exercise (A2.5). Naming a door, clearing its name, the kind refusals, the
 * length bound, the new-badge clear, shutting, reopening and deleting are all still pinned —
 * on the one surface that now owns them. Nothing was dropped in the move; what changed is
 * the page the assertions run against and, where the vocabulary changed, the words.
 * </p>
 *
 * <p>
 * What is new is everything the doors programme adds: the chip that refuses to say
 * "Working", the two chips for two dimensions, the state paragraph that states both halves,
 * the two scan numbers that are never a zero on a failed read, the signals that identify
 * nobody, and the fleet result that says which doors confirmed.
 * </p>
 */

const DOOR_ID = "99999999-9999-9999-9999-999999999999";
const OTHER_ID = "99999999-9999-9999-9999-99999999aaaa";

describe("the doors surface", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const settingsRoute = (overrides: Record<string, unknown> = {}) =>
    ({ path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...overrides } });

  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  /** The whole club, served by a stateful doors API. */
  const club = (
    doors: Record<string, unknown>[],
    options: Parameters<typeof doorsServer>[1] = {},
    settings: Record<string, unknown> = {},
  ) => {
    const server = doorsServer(doors, options);
    const stub = stubFetch([settingsRoute(settings), ...server.routes]);
    return { server, stub };
  };

  const openDoors = (doors: Record<string, unknown>[], options: Parameters<typeof doorsServer>[1] = {}, settings = {}) => {
    const made = club(doors, options, settings);
    renderPage(<AdminDoorsPage />);
    return made;
  };

  const openDoor = (
    doors: Record<string, unknown>[],
    options: Parameters<typeof doorsServer>[1] = {},
    settings = {},
    id = DOOR_ID,
  ) => {
    const made = club(doors, options, settings);
    renderPage(
      <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
      { initialEntries: [`/admin/doors/${id}`] },
    );
    return made;
  };

  // --- W1.1, the overview --------------------------------------------------------

  describe("the overview", () => {
    /**
     * <b>D1 / A2.1.</b> "Working" asserts the door works. This product knows the board
     * answered N seconds ago, and nothing else: there is no door sensor, the relay may be
     * dead and the lock may be seized.
     */
    it("says Reporting, and no chip on the page says Working", async () => {
      openDoors([doorFixture({ last_seen_at: ago(12) })]);

      expect(await screen.findByText("Reporting")).toBeInTheDocument();
      expect(screen.getByText(/Heard from 12s ago/)).toBeInTheDocument();
      // Scoped to the tile rather than the document: `ConfirmButton`'s pending label is the
      // literal "Working…", it is aria-hidden until the button is in flight, and it is a
      // shared primitive's word for a REQUEST — not a claim about a door. The claim this
      // holds is that no chip and no sentence about a door says it.
      const tile = screen.getByRole("article", { name: "Side door" });
      expect(tile.textContent).not.toContain("Working");
      expect(tile.textContent).not.toContain("Online");
    });

    /** Two chips, two dimensions — and the second is keyed on the NAME (D2 / A2.2). */
    it("renders a liveness chip and a separate chip for a door with no name", async () => {
      openDoors([doorFixture({ gate_key: null, auto_registered: false })]);

      expect(await screen.findByText("Needs a door name")).toBeInTheDocument();
      expect(screen.getByText("Reporting")).toBeInTheDocument();
    });

    it("says nothing of the sort for a named door, even a brand new one", async () => {
      openDoors([doorFixture({ gate_key: "side-door", auto_registered: true })]);

      await screen.findByText("Reporting");
      expect(screen.queryByText("Needs a door name")).toBeNull();
    });

    it("says what a reporting unnamed door cannot do while it is offline", async () => {
      openDoors([doorFixture({ gate_key: null })]);

      expect(await screen.findByText(/opens nothing at all while it is offline/)).toBeInTheDocument();
    });

    it("says what a silent door is still doing, and when its list dies", async () => {
      openDoors([doorFixture({ last_seen_at: ago(6 * 60) })]);

      const notice = await screen.findByText(/arrives only when it calls in again/);
      expect(notice).toHaveTextContent(/goes stale on \w{3} \d{1,2}/);
      expect(notice).toHaveTextContent("opens for members with a booking");
    });

    /**
     * <b>C2, on the tile.</b> `doorStateChip` collapses liveness into "Shut", because shut
     * outranks liveness — which is right for a door the club can reach and hides the only
     * thing that matters about one it cannot. Found by looking at a rendered overview where
     * the banner said "2 confirmed, 1 not yet" over three tiles that looked identical.
     */
    it("wears Shut AND Not reporting when both are true", async () => {
      openDoors([doorFixture({ enabled: false, last_seen_at: ago(3600) })]);

      expect(await screen.findByText("Shut")).toBeInTheDocument();
      expect(screen.getByText("Not reporting")).toBeInTheDocument();
    });

    it("wears only Shut when the club can still reach it", async () => {
      openDoors([doorFixture({ enabled: false, last_seen_at: ago(12) })]);

      expect(await screen.findByText("Shut")).toBeInTheDocument();
      expect(screen.queryByText("Not reporting")).toBeNull();
    });

    it("says a shut door opens for nobody AND that a cut-off one keeps admitting", async () => {
      openDoors([doorFixture({ enabled: false })]);

      const notice = await screen.findByText(/This door is shut\./);
      expect(notice).toHaveTextContent("opens for nobody");
      expect(notice).toHaveTextContent("keeps admitting members with a booking");
      // A5: never "you" — a club has several admins and this was true of at most one.
      expect(notice.textContent).not.toContain("You shut");
    });

    /** A door that has never called in holds no list, so there is no time to print. */
    it("renders no NaN and no Invalid Date for a door that has never called in", async () => {
      openDoors([doorFixture({ last_seen_at: null })]);

      expect(await screen.findByText(/it has never called in, so it holds no list at all/)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("NaN");
      expect(document.body.textContent).not.toContain("Invalid Date");
    });

    /**
     * <b>The two numbers, and the day boundary they are measured from.</b> One headline
     * number per door on a list of doors is a footfall ranking by accident.
     */
    it("renders two numbers under a named club-time boundary", async () => {
      openDoors([doorFixture()], {
        dayStartedAt: "2026-09-19T00:00:00Z",
        rows: { [DOOR_ID]: { today: { released: 23, refused: 2 } } },
        timezone: "UTC",
      });

      expect(await screen.findByText("Since 00:00 club time")).toBeInTheDocument();
      expect(screen.getByText("23 released · 2 refused")).toBeInTheDocument();
    });

    /** A zero rendered on a failed count is the admin-failed-read defect with a new noun. */
    it("says the count could not be read rather than rendering a zero", async () => {
      openDoors([doorFixture()], { rows: { [DOOR_ID]: { today: null } } });

      expect(await screen.findByText("Today's scans could not be read.")).toBeInTheDocument();
      expect(screen.queryByText(/0 released/)).toBeNull();
    });

    /**
     * <b>The failed read must not render the empty sentence.</b> An admin who reads "no
     * doors" while a door is shut goes to look for a board that is fine.
     */
    it("separates a failed read from an empty club", async () => {
      stubFetch([
        settingsRoute(),
        { path: "/api/v1/admin/doors", status: 503, body: {} },
      ]);
      renderPage(<AdminDoorsPage />);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Nothing has changed at the doors themselves");
      expect(screen.queryByText("No doors have called in yet.")).toBeNull();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    it("tells an empty club how a door gets onto this list", async () => {
      openDoors([]);

      expect(await screen.findByText("No doors have called in yet.")).toBeInTheDocument();
      expect(screen.getByText(/registers itself the first time it is powered on/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Go to Devices" })).toHaveAttribute("href", "/admin/devices");
    });

    /** <b>A2.3.</b> No sort control at any width — a sorted door list is a footfall ranking. */
    it("offers nothing that sorts or reorders the doors", async () => {
      openDoors([doorFixture(), doorFixture({ id: OTHER_ID, name: "Front door", gate_key: "front-door" })]);

      await screen.findAllByText("Reporting");
      expect(screen.queryByRole("button", { name: /sort/i })).toBeNull();
      expect(screen.queryByRole("combobox", { name: /sort/i })).toBeNull();
      expect(screen.queryByLabelText(/sort/i)).toBeNull();
    });

    /**
     * <b>A10 reverses this.</b> The overview re-sorted by severity on every poll, so cards
     * swapped position under a thumb already on its way down — a reviewer tapped a door and
     * landed on a different one. Attention is carried by the chips and by the summary line,
     * which LINKS to the door that needs somebody; the order itself is stable.
     */
    it("keeps the doors in name order however their state changes", async () => {
      const { server } = openDoors([
        doorFixture({ id: OTHER_ID, name: "Alpha door", gate_key: "alpha" }),
        doorFixture({ name: "Zulu door", gate_key: "zulu" }),
      ]);

      await screen.findAllByText(/door/);
      const names = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
      expect(names()).toEqual(["Alpha door", "Zulu door"]);

      // Zulu goes quiet. Under the old rule this jumped to the top of the list on the next
      // poll — and the reviewer's thumb was already descending on the card that had been
      // there. The card that needs somebody is LAST here, by name, and stays last.
      server.current()[1].last_seen_at = ago(3600);
      document.dispatchEvent(new Event("visibilitychange"));

      await screen.findByText(/Zulu door has not been heard from/);
      expect(names()).toEqual(["Alpha door", "Zulu door"]);
    });

    it("names one door in the attention line, counts the rest, and links to it", async () => {
      openDoors([
        doorFixture({ name: "Side door", last_seen_at: ago(3600) }),
        doorFixture({ id: OTHER_ID, name: "Front door", gate_key: null }),
      ]);

      const status = await screen.findByText(/has not been heard from/);
      expect(status).toHaveTextContent("Side door has not been heard from.");
      expect(status).toHaveTextContent("1 other door needs attention.");
      // A10: a count sends nobody anywhere. The line carries the reader to the card.
      expect(screen.getByRole("link", { name: "Go to Side door" }))
        .toHaveAttribute("href", `/admin/doors/${DOOR_ID}`);
    });

    /**
     * <b>E-L6.</b> `/admin/doors` fired three identical `GET /admin/doors` on mount — the
     * banner store re-read on navigation, the page polled on its own, and the gear badge read
     * a third time. Three readers of one fact is also C3, which is why the answer to both is
     * one store that owns the request.
     */
    it("makes one doors request on mount, however many readers are on the page", async () => {
      const { stub } = openDoors([doorFixture()]);

      await screen.findByText("Reporting");
      const reads = stub.calls.filter((c) => c.path === "/api/v1/admin/doors");
      expect(reads).toHaveLength(1);
    });

    /**
     * And the mechanism under it, on its own: three readers asking in ONE tick.
     *
     * <p>
     * The mounted case above passes with or without the in-flight join whenever the page
     * happens to have one reader — which is how a suite comes to hold a finding it cannot
     * actually see. This is the join itself: the banner, the page and the gear badge all
     * ask on mount, and exactly one request leaves the browser.
     * </p>
     */
    it("joins the read already in flight rather than starting a second", async () => {
      const { stub } = club([doorFixture()]);

      await Promise.all([refreshDoorsView(), refreshDoorsView(), refreshDoorsView()]);

      expect(stub.calls.filter((c) => c.path === "/api/v1/admin/doors")).toHaveLength(1);
    });

    /**
     * <b>A8 — while the page cannot read, it does not get to say who is reporting.</b>
     *
     * With the ADMIN's phone offline every age went on ticking from a frozen read, doors
     * flipped one by one to "Not reporting", and the page asserted "nothing can reach it"
     * about boards that were, as far as anybody knew, fine.
     */
    it("suspends every liveness claim once its own reads are failing", async () => {
      // A route that can be taken away mid-test, which is what losing signal actually looks
      // like: the club is fine and the browser is not.
      const offline = { now: false };
      const server = doorsServer([doorFixture()]);
      const doorsRoute = server.routes.find((r) => r.path === "/api/v1/admin/doors")!;
      stubFetch([
        settingsRoute(),
        ...server.routes.filter((r) => r !== doorsRoute),
        {
          path: "/api/v1/admin/doors",
          respond: (r) => (offline.now ? refuse(503, {}) : doorsRoute.respond!(r)),
        },
      ]);
      renderPage(<AdminDoorsPage />);
      expect(await screen.findByText("Reporting")).toBeInTheDocument();

      // Two failed checks — the same threshold the staleness notice uses, so the page tells
      // one story rather than two.
      offline.now = true;
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Still can't"));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

      await waitFor(() => {
        expect(screen.getByText(/can't say whether the doors are reporting/)).toBeInTheDocument();
      });
      expect(screen.queryByText("Reporting")).toBeNull();
      expect(screen.queryByText("Not reporting")).toBeNull();
      expect(document.body.textContent).not.toContain("Nothing can reach it");
    });

    /** C4 / A8: a Refresh pressed with no signal answers, rather than doing nothing visible. */
    it("says what Refresh found, including when it found nothing", async () => {
      const offline = { now: false };
      const server = doorsServer([doorFixture()]);
      const doorsRoute = server.routes.find((r) => r.path === "/api/v1/admin/doors")!;
      stubFetch([
        settingsRoute(),
        ...server.routes.filter((r) => r !== doorsRoute),
        {
          path: "/api/v1/admin/doors",
          respond: (r) => (offline.now ? refuse(503, {}) : doorsRoute.respond!(r)),
        },
      ]);
      renderPage(<AdminDoorsPage />);

      fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Checked just now."));

      offline.now = true;
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent("Still can't reach the club.");
      });
    });

    /**
     * <b>A9 / B9.</b> The chips were two unexplained words on the overview, with the
     * explanation on a page the admin had not opened — and they survived a shut, where
     * "usually a dirty scanner" is advice about a question nobody is asking.
     */
    it("explains a signal on the card, with its action", async () => {
      openDoors([doorFixture()], {
        rows: {
          [DOOR_ID]: {
            signals: [{
              kind: "may_not_be_releasing", since: ago(600), until: ago(0), scans: 3,
            }],
          },
        },
      });

      expect(await screen.findByText(/A code was accepted three times in under a minute/))
        .toHaveTextContent("The lock is released for 3 seconds.");
      expect(screen.getByRole("link", { name: /Change how long the lock is released — Side door/ }))
        .toHaveAttribute("href", "/admin/settings#setting-gate-unlock-seconds");
    });

    it("says nothing about a signal on a door the club has shut", async () => {
      openDoors([doorFixture({ enabled: false })], {
        rows: {
          [DOOR_ID]: {
            signals: [{ kind: "may_not_be_releasing", since: ago(600), until: ago(0), scans: 3 }],
          },
        },
      });

      await screen.findByText("Shut");
      expect(screen.queryByText("May not be releasing")).toBeNull();
      expect(document.body.textContent).not.toContain("Change how long the lock is released");
    });

    it("says nothing about a signal on a door nothing can reach", async () => {
      openDoors([doorFixture({ last_seen_at: ago(3600) })], {
        rows: {
          [DOOR_ID]: {
            signals: [{ kind: "refusal_spike", since: ago(600), until: ago(0), scans: 11 }],
          },
        },
      });

      await screen.findByText("Not reporting");
      expect(screen.queryByText("Refusing a lot")).toBeNull();
      expect(document.body.textContent).not.toContain("usually a dirty scanner");
    });

    /**
     * <b>A11.</b> "Door gate" is what `DeviceRegistryService` calls every gate that registers
     * itself, so it named none of the five doors in that state — and the card then said
     * "no door name yet" and "Needs a door name" beside it, three vocabularies for one thing.
     */
    it("calls an unnamed board an unnamed scanner with its own board code", async () => {
      openDoors([doorFixture({ name: "Door gate", gate_key: null })]);

      expect(await screen.findByRole("heading", { level: 3, name: "Unnamed scanner (gate-0a1b2c)" }))
        .toBeInTheDocument();
    });

    /**
     * <b>A13.</b> A door called "A" gave a 34 px link — the one control a card exists to
     * offer, under the 44 px target this whole surface is built to, and the shorter the name
     * the smaller the target got.
     */
    it("gives a short door name a full-sized tap target", async () => {
      openDoors([doorFixture({ name: "A" })]);

      const link = await screen.findByRole("link", { name: "A" });
      expect(link.className).toContain("min-w-11");
      expect(link.className).toContain("min-h-11");
    });

    /** Tokens only. AdminDevices' raw palette is not the exemplar here (A2.7, UX bar). */
    it("uses no raw palette class anywhere on the page", async () => {
      openDoors([doorFixture()]);
      await screen.findByText("Reporting");

      // Matched as a Tailwind UTILITY rather than as a substring: "-translate-y-1/2"
      // contains the letters "slate-", and an assertion that trips on it is one the next
      // person deletes rather than reads.
      const raw = /(?:^|\s)-?(?:bg|text|border|ring|from|via|to|fill|stroke|divide|placeholder|accent|caret|outline|shadow)-(?:slate|amber|emerald|sky)-\d/;
      for (const element of Array.from(document.querySelectorAll("[class]"))) {
        const cls = element.getAttribute("class") ?? "";
        expect(raw.test(cls), cls).toBe(false);
      }
    });
  });

  // --- W1.6, the signals ---------------------------------------------------------

  describe("the door-scoped signals", () => {
    const spike = { kind: "refusal_spike", since: ago(1200), until: ago(0), scans: 11 };
    const releasing = { kind: "may_not_be_releasing", since: ago(50), until: ago(0), scans: 4 };

    it("chips a spike on the tile", async () => {
      openDoors([doorFixture()], { rows: { [DOOR_ID]: { signals: [spike] } } });

      expect(await screen.findByText("Refusing a lot")).toBeInTheDocument();
    });

    it("says on the door's page how many SCANS, over the club's own window", async () => {
      openDoor([doorFixture()], { rows: { [DOOR_ID]: { signals: [spike] } } }, { door_refusal_spike_minutes: 20 });

      const notice = await screen.findByText(/turned away 11 scans in the last 20 minutes/);
      expect(notice).toHaveTextContent("This counts scans, not people");
    });

    /** A threshold stated with a guessed number is worse than no spike notice at all. */
    it("renders no spike notice when the settings read failed", async () => {
      const server = doorsServer([doorFixture()], { rows: { [DOOR_ID]: { signals: [spike] } } });
      stubFetch([
        { path: "/api/v1/admin/settings/", status: 503, body: {} },
        ...server.routes,
      ]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      await screen.findByText("Side door");
      expect(screen.queryByText(/turned away/)).toBeNull();
    });

    it("states the releasing signal's own limits and the release seconds, both ways", async () => {
      openDoor([doorFixture({ name: "Front door" })], { rows: { [DOOR_ID]: { signals: [releasing] } } }, { gate_unlock_seconds: 3 });

      const notice = await screen.findByText(/may not be releasing/);
      expect(notice).toHaveTextContent("people do not scan again when a door opens");
      expect(notice).toHaveTextContent("cannot tell a stuck door from");
      expect(notice).toHaveTextContent("The release is set to 3 seconds.");
      /**
       * <b>A9.</b> This linked to a bare `/admin/settings`, which lands an admin at the top
       * of a page about 5 400 px long with no indication which of its forty fields the
       * signal meant — the reviewer scrolled looking for it. The hash is the settings page's
       * own `#setting-<key>` convention: it scrolls the field into view, moves focus to it
       * and highlights it. The door's name is in the link text because three
       * identically-worded links on one admin's screen is reviewer B's repeated-link
       * finding.
       */
      expect(screen.getByRole("link", { name: /Change how long the lock is released — Front door/ }))
        .toHaveAttribute("href", "/admin/settings#setting-gate-unlock-seconds");
    });

    /**
     * <b>D4, on screen.</b> The derivation names a credential; the flag must not. No member
     * name, no eight-hex fingerprint, no id — asserted over the whole rendered page, because
     * the way this rule breaks is a later sentence, not the one reviewed.
     */
    it("names nobody, anywhere on a page rendering a signal", async () => {
      openDoor([doorFixture({ name: "Front door" })], {
        rows: { [DOOR_ID]: { signals: [releasing] } },
        activity: [],
      }, { gate_unlock_seconds: 3 });

      await screen.findByText(/may not be releasing/);
      const notice = screen.getByText(/may not be releasing/).textContent ?? "";
      expect(notice).not.toMatch(/\b[0-9a-f]{8}\b/);
      expect(notice).not.toContain("Ada Lovelace");
    });

    /** A signal is a reading, not an event: it is never a row in the club log. */
    it("puts no signal row in the feed", async () => {
      openDoor([doorFixture()], {
        rows: { [DOOR_ID]: { signals: [spike] } },
        activity: [activityFixture()],
      }, { door_refusal_spike_minutes: 20 });

      await screen.findByText(/turned away 11 scans/);
      const feed = screen.getByRole("region", { name: "Scans at this door" });
      expect(within(feed).queryByText(/turned away/)).toBeNull();
    });
  });

  // --- W1.2, the door page's feed ------------------------------------------------

  describe("a door's feed", () => {
    /**
     * Open on arrival, unlike the collapsed panel on Devices — that one is shut because a
     * club with eight boards would make eight extra calls on a list page. This page is one
     * door and the feed is why it was opened.
     */
    it("is visible on load with no disclosure to press", async () => {
      openDoor([doorFixture()], { activity: [activityFixture()] });

      expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Door activity/ })).toBeNull();
    });

    /**
     * <b>A1.2.</b> The chip reads "Lock released". P2 forbids implying the door moved, and
     * a sentence underneath cannot retract a word the chip has already said.
     */
    it("chips a granted scan as Lock released, never Opened", async () => {
      openDoor([doorFixture()], { activity: [activityFixture()] });

      expect(await screen.findByText("Lock released")).toBeInTheDocument();
      const feed = screen.getByRole("region", { name: "Scans at this door" });
      expect(within(feed).queryByText("Opened")).toBeNull();
    });

    it("puts the refusal reason in the chip, before the member's name", async () => {
      openDoor([doorFixture()], {
        activity: [activityFixture({ action: "gate.denied_no_booking", reason: "no_booking" })],
      });

      expect(await screen.findByText("No booking")).toBeInTheDocument();
      expect(screen.getByText(/No booking that opens this door/)).toBeInTheDocument();
      // Never the raw token on screen. The whole point of the dictionary.
      expect(document.body.textContent).not.toContain("no_booking");
    });

    /**
     * An offline row is distinct three ways, and its time is the SCAN's own — the API
     * resolves it at the scan's time, not the upload's.
     */
    it("marks an offline open as the board's own decision, at the scan's own time", async () => {
      const at = "2026-09-19T18:04:00Z";
      openDoor([doorFixture()], {
        // WIRE-R1 §2: `delivered_at` is non-null on offline rows ONLY, so an offline fixture
        // that omitted it would be a shape the API cannot emit — and the row's whole point
        // is that it carries TWO instants.
        activity: [activityFixture({
          at, action: "device.gate_open", reason: null, offline: true,
          delivered_at: "2026-09-19T18:31:00Z",
        })],
      });

      expect(await screen.findByText("Offline")).toBeInTheDocument();
      expect(screen.getByText(/Lock released while offline/)).toBeInTheDocument();
      const feed = screen.getByRole("region", { name: "Scans at this door" });
      // A7: the `<time>` carries the clock face AND the age now, in two spans, so the age is
      // no longer the element's own text node. `closest("time")` is what pins the instant.
      const when = within(feed).getByText(/ago$/).closest("time")!;
      expect(when).toHaveAttribute("datetime", at);
      // And the exact time is VISIBLE, not only in the title — the whole of A7.
      expect(when.textContent).toMatch(/\d{2}:\d{2}/);
      /**
       * <b>A4.</b> "Last heard from 21:00" beside a scan "decided at the door at 21:25"
       * reads as a contradiction until the row says the two are different facts. It said so
       * only in a `title`, which is invisible on a phone and to a screen reader — so the
       * sentence is in the row now, and it names the delivery as well as the scan.
       *
       * A13: day before month, 24-hour clock. A second format on this page rendered
       * "9/19/26, 9:25 PM" through `utils.formatInstant`, which passes `undefined` as the
       * locale.
       */
      expect(when.getAttribute("title")).toContain("Decided at the door at");
      expect(within(feed).getByText(/Decided at the door at/)).toHaveTextContent(
        "the door told us at",
      );
      expect(when.getAttribute("title")).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{2}/);
      expect(when.getAttribute("title")).not.toMatch(/\b[AP]M\b/);
    });

    /**
     * <b>A3.</b> "Decided at the door at 09:38 — the door told us at 09:38" is one fact
     * printed twice, and nine rows of it taught a reviewer to read the pair as a clock
     * disagreeing with itself. When the two land in one minute the row prints ONE time and
     * says the club heard within it.
     */
    it("prints one time when the scan and the delivery are in the same minute", async () => {
      openDoor([doorFixture()], {
        activity: [activityFixture({
          at: "2026-09-19T18:04:02Z", action: "device.gate_open", reason: null, offline: true,
          delivered_at: "2026-09-19T18:04:51Z",
        })],
      });

      const feed = await screen.findByRole("region", { name: "Scans at this door" });
      expect(within(feed).getByText(/Decided at the door at/))
        .toHaveTextContent("and the club heard within the minute");
      expect(within(feed).queryByText(/the door told us at/)).toBeNull();
    });

    /**
     * <b>A4's other half.</b> Where the API carries a `delivered_at`, the row says WHEN the
     * club was told rather than only that it was told later.
     */
    it("names the delivery time on an offline row when the API carries one", async () => {
      const at = "2026-09-19T18:04:00Z";
      openDoor([doorFixture()], {
        activity: [activityFixture({
          at, action: "device.gate_open", reason: null, offline: true,
          delivered_at: "2026-09-19T18:31:00Z",
        })],
      });

      const feed = await screen.findByRole("region", { name: "Scans at this door" });
      // Both instants, in WIRE-R1 §2's own words. An /events upload IS contact, so
      // `last_seen_at` moving PAST a scan it delivered is not a contradiction — which is
      // exactly why the row has to say which instant is which rather than showing one.
      expect(within(feed).getByText(/Decided at the door at/))
        .toHaveTextContent("Decided at the door at 20:04 \u2014 the door told us at 20:31.");
    });

    /**
     * WIRE-R1 §2: "Never render a delay for delivered_at null." A row the club decided as it
     * happened has ONE instant, and inventing a second is the same class of falsehood as
     * the contradiction A4 was raised about — the first draft of this fix filled the gap
     * with "the club was told when the door next called in", which is a delay that row
     * never had.
     */
    it("invents no delivery time for a row the club decided as it happened", async () => {
      openDoor([doorFixture()], {
        activity: [activityFixture({ at: "2026-09-19T18:04:00Z", delivered_at: null })],
      });

      const feed = await screen.findByRole("region", { name: "Scans at this door" });
      expect(within(feed).queryByText(/told us at/)).toBeNull();
      expect(within(feed).queryByText(/Decided at the door at/)).toBeNull();
    });

    /**
     * <b>E-L2 / A3.</b> It rendered as "Refused / No reason recorded", which reads as a gap in
     * the trail; there is no gap. And a reviewer read nine offline rows where some named a
     * member and some did not, with nothing on the page to reconcile them — the list IS the
     * reconciliation, and it is said once beside the rows rather than on each of them.
     */
    it("says an offline refusal was a code the door's list did not hold, and why it names nobody", async () => {
      openDoor([doorFixture()], {
        activity: [activityFixture({
          action: "device.unknown_scan", reason: null, offline: true, member: null, fingerprint: "9ab0cd12",
        })],
      });

      expect(await screen.findByText(/Unknown code · 9ab0cd12/)).toBeInTheDocument();
      expect(screen.getByText(/Code not on the door's saved list/)).toBeInTheDocument();
      expect(screen.getByText(/An offline row names somebody when the code was on the door's saved list/))
        .toHaveTextContent("resolves to nobody at all");
      expect(document.body.textContent).not.toContain("Unknown member");
      expect(document.body.textContent).not.toContain("No reason recorded");
    });

    it("says when the newest scan is on an earlier club day, and still shows the rows", async () => {
      openDoor([doorFixture()], {
        activity: [activityFixture({ at: new Date(Date.now() - 3 * 86_400_000).toISOString() })],
        dayStartedAt: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
      });

      expect(await screen.findByText(/No scans at this door since/)).toBeInTheDocument();
      expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    });

    /** A failed read must not make a claim about the DOOR out of a claim about the request. */
    it("says the trail could not be read rather than that nothing is recorded", async () => {
      const server = doorsServer([doorFixture()]);
      stubFetch([
        settingsRoute(),
        { path: `/api/v1/admin/devices/${DOOR_ID}/activity`, status: 500, body: {} },
        ...server.routes,
      ]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      expect(await screen.findByText(/Could not read that board's activity/)).toBeInTheDocument();
      expect(screen.queryByText(/Nothing recorded/)).toBeNull();
    });

    it("says nothing is recorded yet for a door nobody has been through", async () => {
      openDoor([doorFixture()], { activity: [] });

      expect(await screen.findByText("Nothing recorded for this door yet.")).toBeInTheDocument();
    });

    it("links every one of this door's scans to the club log, pre-filtered", async () => {
      openDoor([doorFixture()], { activity: [activityFixture()] });

      expect(await screen.findByRole("link", { name: "All scans at this door" }))
        .toHaveAttribute("href", `/admin/doors/log?door=${DOOR_ID}`);
    });
  });

  // --- W1.4, the door card -------------------------------------------------------

  describe("the door card", () => {
    it("says nobody has written down where the board is, rather than leaving a blank", async () => {
      openDoor([doorFixture({ location_note: null })]);

      expect(await screen.findByText(/Nobody has written down where this board is/)).toBeInTheDocument();
    });

    /**
     * The default is a real answer, and the hint is the strongest sentence on the surface:
     * an earlier version of this product inferred this from the board's flags and was wrong.
     */
    it("renders the unknown power-loss answer as an answer, and says who has to look", async () => {
      openDoor([doorFixture({ power_loss_behaviour: "not_established" })]);

      expect(await screen.findByText("Not established")).toBeInTheDocument();
      expect(screen.getByText(/Ask whoever fitted the lock/)).toHaveTextContent(
        "must never be guessed from the board's settings",
      );
    });

    it("is a radio group of exactly three real answers, with no placeholder", async () => {
      openDoor([doorFixture()]);

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      const radios = screen.getAllByRole("radio");
      expect(radios).toHaveLength(3);
      expect(screen.getByRole("radio", { name: /Not established/ })).toBeChecked();
    });

    it("saves the note and the behaviour on the devices PATCH", async () => {
      const { server, stub } = club([doorFixture()]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      fireEvent.change(screen.getByLabelText("Where this board is"), {
        target: { value: "  In the cupboard above the fuse board  " },
      });
      fireEvent.click(screen.getByRole("radio", { name: /Released/ }));
      fireEvent.click(screen.getByRole("button", { name: /Save this door/ }));

      await waitFor(() => {
        // A19: one form, one PATCH, all four fields. `name` and `gate_key` ride along
        // unchanged — the API applies a value it is given whether or not it differs.
        expect(stub.calls.find((c) => c.method === "PATCH")?.body).toEqual({
          name: "Side door",
          gate_key: "side-door",
          location_note: "In the cupboard above the fuse board",
          power_loss_behaviour: "released",
        });
      });
      await waitFor(() => expect(server.current()[0].power_loss_behaviour).toBe("released"));
    });

    /** The API's own bound, on the field, so a long note is stopped where it is typed. */
    it("holds the note to the 200 characters the API stores", async () => {
      openDoor([doorFixture()]);

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      expect(screen.getByLabelText("Where this board is")).toHaveAttribute("maxLength", "200");
    });

    it("says no club contact is set, and where to set one", async () => {
      openDoor([doorFixture()], {}, { club_contact_phone: "", club_contact_email: "" });

      expect(await screen.findByText(/No club contact is set/)).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: "Admin settings" })[0])
        .toHaveAttribute("href", "/admin/settings");
    });

    it("shows the club contact when the club has one", async () => {
      openDoor([doorFixture()], {}, { club_contact_phone: "076 226 1390" });

      expect(await screen.findByText(/076 226 1390/)).toBeInTheDocument();
    });
  });

  // --- W1.4, the printable card --------------------------------------------------

  describe("the printable door card", () => {
    const openCard = (settings = {}) => {
      const server = doorsServer([doorFixture({
        location_note: "In the cupboard above the fuse board", power_loss_behaviour: "released",
      })]);
      stubFetch([settingsRoute(settings), ...server.routes]);
      renderPage(
        <Routes><Route path="/admin/doors/:id/card" element={<AdminDoorsCardPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}/card`] },
      );
    };

    it("carries what somebody standing at the door needs, and a printed date", async () => {
      openCard({ club_contact_phone: "076 226 1390" });

      // B22 / C13: the club's OWN name for the door is the headline, and the slug goes
      // beneath it. The heading used to BE the slug — "side-door" in 36 px on a card taped
      // to a wall, which is the one word neither a member nor a volunteer uses for it. The
      // slug stays on the sheet: it is what a scan is recorded against.
      expect(await screen.findByRole("heading", { name: "Side door" })).toBeInTheDocument();
      expect(screen.getByText("side-door")).toBeInTheDocument();
      expect(screen.getByText("gate-0a1b2c")).toBeInTheDocument();
      expect(screen.getByText("5ccf7f0a1b2c")).toBeInTheDocument();
      expect(screen.getByText(/In the cupboard above the fuse board/)).toBeInTheDocument();
      expect(screen.getByText(/RELEASED/)).toBeInTheDocument();
      expect(screen.getByText(/076 226 1390/)).toBeInTheDocument();
      expect(screen.getByText(/Check it is still right/)).toBeInTheDocument();
    });

    /**
     * <b>A refusal rather than an omission.</b> The club's device key registers boards, reads
     * heartbeats and pulls the whole roster, and this card lives on a wall in a corridor.
     */
    it("carries no club API key and no member name", async () => {
      openCard();

      await screen.findByRole("heading", { name: "Side door" });
      expect(document.body.textContent).not.toContain("crsdr_live");
      expect(document.body.textContent).not.toContain("Ada Lovelace");
    });

    it("hides its own chrome from the printed sheet", async () => {
      openCard();

      await screen.findByRole("heading", { name: "Side door" });
      const button = screen.getByRole("button", { name: /Print/ });
      expect(button.closest("[data-print-hide]")).not.toBeNull();
    });
  });

  // --- W1.5, shutting and reopening ----------------------------------------------

  describe("shutting a door", () => {
    /**
     * <b>Moved from AdminDevices.test.tsx and reworded (A1.4).</b> One name for the 403 path
     * on a gate, and the confirm opens with the words on the button.
     */
    it("confirms with the door's own consequence, and sends only enabled", async () => {
      const { stub } = club([doorFixture()]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: "Shut this door — Side door" }));
      expect(stub.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

      const confirm = await screen.findByRole("button", { name: "Shut this door — Side door — tap again to confirm" });
      // The consequence is on screen, in the confirm label the button is now showing. It is
      // not in the accessible NAME because `ConfirmButton`'s aria-label replaces its
      // contents — which is why the same sentence is also rendered above the control, where
      // a screen reader reaches it whatever the button is doing.
      // `getAllByText`: ConfirmButton renders its confirm label twice — once in the visible
      // layer and once in an aria-hidden width sentinel, which is what stops the button
      // resizing as it arms. Both carry the same sentence, and it is the sentence that is
      // being held here.
      // B3 / B5: the consequence is generated from THIS door's situation — in contact and
      // named — and is ≤25 words. The old confirm described the pair in the abstract, so a
      // door that is in contact was told about doors that are not.
      expect(screen.getAllByText("Shut this door? It hears this at once and opens for nobody.")[0])
        .toBeInTheDocument();
      // And the long explanation is still on the page, beside the control, as plain text.
      expect(screen.getByText(/refuses every scan at this door from the instant the switch is thrown/))
        .toHaveTextContent("a door marks nobody as having arrived");
      fireEvent.click(confirm);

      await waitFor(() => expect(stub.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
      expect(stub.calls.find((c) => c.method === "PATCH")!.raw).toBe('{"enabled":false}');
    });

    /** Never "Take out of service" on a door, and never the box's consequence. */
    it("uses none of the court box's vocabulary", async () => {
      openDoor([doorFixture()]);

      await screen.findByText("Side door");
      expect(screen.queryByRole("button", { name: /Take out of service/ })).toBeNull();
      expect(document.body.textContent).not.toContain("refunded in full");
      expect(document.body.textContent).not.toContain("switching lights on");
    });

    it("reopens a shut door and says a reachable one opens on the very next scan", async () => {
      const { stub } = club([doorFixture({ enabled: false })]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: "Reopen this door — Side door" }));
      const confirm = await screen.findByRole("button", { name: "Reopen this door — Side door — tap again to confirm" });
      expect(screen.getAllByText("Reopen this door? It opens for members again from the very next scan.")[0])
        .toBeInTheDocument();
      fireEvent.click(confirm);

      await waitFor(() => expect(stub.calls.find((c) => c.method === "PATCH")?.raw).toBe('{"enabled":true}'));
    });

    /**
     * <b>B3.</b> An unnamed door is sent an EMPTY list, so it opens for nobody while it is
     * offline — and the confirm told it, on the control that shuts it, that it "keeps
     * admitting booked members from the list it last downloaded". Every door in a club is in
     * this state on install day.
     */
    it("never tells an unnamed, unreachable door it keeps admitting members", async () => {
      openDoor([doorFixture({ gate_key: null, last_seen_at: ago(3600) })]);

      fireEvent.click(await screen.findByRole("button", { name: /^Shut this door/ }));
      // `findAllByText`: ConfirmButton renders its confirm label twice — once visibly and
      // once in an aria-hidden width sentinel that stops the button resizing as it arms.
      const armed = (await screen.findAllByText(/^Shut this door\? Nothing can reach it/))[0];
      expect(armed).toHaveTextContent("with no saved list it already opens for nobody");
      expect(armed.textContent).not.toContain("admitting booked members");
    });

    /**
     * <b>B8.</b> "It opens for nobody that can reach the club's server" attaches its relative
     * clause to "nobody" and so reads as its own opposite, on the standing notice above the
     * control that undoes it.
     * <b>A5.</b> And it said "You shut this door." to every admin in the club.
     */
    it("says a shut door is shut, who shut it, and nothing that reads backwards", async () => {
      openDoor([doorFixture({
        enabled: false, name: "Front door", shut_by_name: "Priya Naidoo",
        out_of_service_since: new Date("2026-09-20T19:40:00Z").toISOString(),
      })]);

      const notice = await screen.findByText(/Front door is shut/);
      expect(notice).toHaveTextContent("The club's server is refusing every scan at this door.");
      expect(notice).toHaveTextContent("Shut by Priya Naidoo on");
      expect(document.body.textContent).not.toContain("opens for nobody that can reach");
      expect(document.body.textContent).not.toContain("You shut this door");
    });

    /**
     * <b>Moved from AdminDevices.test.tsx.</b> Deleting is not a revocation; what differs on
     * a door is what comes back — a door with no name.
     */
    it("says a deleted door comes back unnamed", async () => {
      const { stub } = club([doorFixture({ name: "Front door" })]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: "Delete this door — Front door" }));
      const armed = await screen.findByRole("button", { name: "Delete this door — Front door — tap again to confirm" });
      // A2 / B5: the confirm is ≤25 words and answers the question a reviewer went looking
      // for — what happens to the door's past scans. It is NOT "the whole history goes",
      // which is what the old confirm left an admin to infer by listing three things and
      // stopping.
      expect(screen.getAllByText(/Delete this door\? Its name, its place and its power answer go/)[0])
        .toHaveTextContent("Its past scans stay in the club log under its old name");
      // C10 / A12: everything that no longer fits is still on the page beside the control.
      expect(screen.getByText(/Deleting Front door throws away/))
        .toHaveTextContent("what the lock does with no power");
      expect(screen.getByText(/Deleting Front door throws away/))
        .toHaveTextContent("Its past scans are NOT deleted");
      expect(screen.queryByText(/The box re-registers/)).toBeNull();

      fireEvent.click(armed);
      await waitFor(() => {
        expect(stub.calls.find((c) => c.method === "DELETE")?.path).toBe(`/api/v1/admin/devices/${DOOR_ID}`);
      });
    });
  });

  // --- B1 / B6 / B10 / E-L3: the door's own page ----------------------------------

  describe("one door's page", () => {
    /**
     * <b>B1.</b> The detail page made ZERO repeat requests over seventy seconds while its
     * relative clocks went on ticking: another admin's shut was invisible, "Shut this door"
     * was still offered for a door that was already shut, and no banner appeared. The
     * overview polled; the page somebody opens BECAUSE something is wrong did not.
     */
    it("re-reads while it is in front, and says that it does", async () => {
      vi.useFakeTimers();
      const { stub } = club([doorFixture()]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );
      await vi.advanceTimersByTimeAsync(0);
      const before = stub.calls.filter((c) => c.path === "/api/v1/admin/doors").length;

      // BOTH reads. The store's poll alone leaves the scans frozen — and the scans are
      // where another admin's evening actually shows up, which is why somebody opened this
      // page. Counting only `/admin/doors` is a test that passes with the feed's timer
      // deleted, which is half of the finding still shipping.
      const feedPath = `/api/v1/admin/devices/${DOOR_ID}/activity`;
      const feedBefore = stub.calls.filter((c) => c.path.startsWith(feedPath)).length;
      expect(feedBefore).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(16_000);

      expect(stub.calls.filter((c) => c.path === "/api/v1/admin/doors").length)
        .toBeGreaterThan(before);
      expect(stub.calls.filter((c) => c.path.startsWith(feedPath)).length)
        .toBeGreaterThan(feedBefore);
      expect(screen.getByText(/Re-reads every 15 seconds while this tab is in front/))
        .toBeInTheDocument();
      vi.useRealTimers();
    });

    /**
     * <b>B1, the other trigger.</b> A tab left on this page for an hour and come back to is
     * the commonest way an admin meets it: the outage email links here. Waiting up to a
     * whole interval to find out what the club looks like NOW is the stale read the finding
     * is about, arriving a few seconds later.
     */
    it("re-reads the scans as soon as the tab comes back to the front", async () => {
      const { stub } = club([doorFixture()]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      const feedPath = `/api/v1/admin/devices/${DOOR_ID}/activity`;
      const feedReads = () => stub.calls.filter((c) => c.path.startsWith(feedPath)).length;
      await waitFor(() => expect(feedReads()).toBeGreaterThan(0));
      const before = feedReads();

      document.dispatchEvent(new Event("visibilitychange"));

      await waitFor(() => expect(feedReads()).toBeGreaterThan(before));
    });

    /**
     * <b>B6.</b> The controls were the third thing on the page, below a feed of up to fifty
     * rows — 5 231 px down on a phone, measured. Somebody opens this page because something
     * is wrong at a door; the thing they came to do was two screens past the thing they came
     * to read.
     */
    it("puts the state and the controls above the scans", async () => {
      openDoor([doorFixture()]);

      await screen.findByRole("heading", { name: "Shutting or removing this door" });
      const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
      expect(headings.indexOf("Shutting or removing this door"))
        .toBeLessThan(headings.indexOf("Scans at this door"));
      expect(headings.indexOf("Shutting or removing this door"))
        .toBeLessThan(headings.indexOf("Door card"));
    });

    it("opens with ten scans and offers the rest, rather than fifty", async () => {
      openDoor([doorFixture()], {
        activity: Array.from({ length: 14 }, (_, i) => activityFixture({ at: ago(i * 60) })),
      });

      const feed = await screen.findByRole("region", { name: "Scans at this door" });
      expect(within(feed).getAllByRole("listitem")).toHaveLength(10);
      fireEvent.click(within(feed).getByRole("button", { name: "Show the other 4 scans" }));
      expect(within(feed).getAllByRole("listitem")).toHaveLength(14);
      // C4: the first row the press revealed takes focus, not `<body>`.
      expect(document.activeElement).not.toBe(document.body);
    });

    /**
     * <b>A5 / E-M6 / E-L3.</b> Nine identical "this door's details or state were changed"
     * rows told an admin nothing, and a clock correction — which is a real thing to know
     * about a board — appeared nowhere at all.
     */
    it("says what each event was and who did it", async () => {
      openDoor([doorFixture()], {
        activity: [
          { ...activityFixture({ at: ago(60), action: "device.updated", reason: null }), change: "shut", actor_name: "Priya Naidoo" },
          { ...activityFixture({ at: ago(120), action: "device.updated", reason: null }), change: "renamed", actor_name: "Ruth Adams" },
          activityFixture({ at: ago(180), action: "device.event_time_clamped", reason: null }),
        ],
      });

      const events = await screen.findByRole("region", { name: "Door events" });
      expect(events).toHaveTextContent("Shut by Priya Naidoo");
      expect(events).toHaveTextContent("Renamed by Ruth Adams");
      // E-L3: the clock correction renders, and it is not given an actor it does not have.
      expect(events).toHaveTextContent("The board's clock was out and was corrected");
      expect(events.textContent).not.toContain("clock was out and was corrected by");
    });

    /**
     * <b>A7 / E-M5 / O1, one list along from where it was fixed.</b>
     *
     * <p>
     * The scan rows were given the club's zone and the EVENT rows were not, so on a page
     * read from anywhere but the club's own timezone the two lists above and below each
     * other dated the same evening differently — and the events list, which is the one that
     * answers "when did somebody shut this door", was the one telling the viewer's time.
     * One formatter on this surface means one ZONE on this surface.
     * </p>
     */
    it("dates a door event in the club's zone, not the viewer's", async () => {
      openDoor([doorFixture()], {
        // A club five hours west of the runner's pinned Africa/Johannesburg.
        timezone: "America/New_York",
        activity: [{
          ...activityFixture({ at: "2026-09-19T22:30:00Z", action: "device.updated", reason: null }),
          change: "shut",
          actor_name: "Priya Naidoo",
        }],
      });

      const events = await screen.findByRole("region", { name: "Door events" });
      // 22:30 UTC is 18:30 in New York and 00:30 the NEXT DAY in Johannesburg — so a page
      // that reads the runner's zone gets both the time and the date wrong.
      expect(events).toHaveTextContent("18:30");
      expect(events.textContent).not.toContain("00:30");
    });

    /**
     * A row written before the server recorded WHICH of the four an edit was still has to
     * say something true. "Details or state changed" is that; guessing a verb — "Someone
     * renamed this door" over a shut — would be this round's own defect in a new place.
     */
    it("says the broad thing for an edit the server could not classify", async () => {
      openDoor([doorFixture()], {
        activity: [activityFixture({ at: ago(60), action: "device.updated", reason: null })],
      });

      const events = await screen.findByRole("region", { name: "Door events" });
      expect(events).toHaveTextContent("Details or state changed");
    });

    /**
     * <b>`unchanged` is a VALUE, not a field that is either there or not.</b>
     *
     * The backend's final wire puts it on every DeviceView — `false` on a list row and on a
     * PATCH that did real work, `true` only on a no-op. A page testing for its presence
     * would report every shut in the club as a shut that had already happened, by somebody
     * it could not name.
     */
    it("reports a shut that did work as work, even carrying unchanged: false", async () => {
      const server = doorsServer([doorFixture({ enabled: true })]);
      stubFetch([
        settingsRoute(),
        ...server.routes,
        {
          method: "PATCH",
          path: `/api/v1/admin/devices/${DOOR_ID}`,
          respond: () => ({ ...doorFixture({ enabled: false }), unchanged: false }),
        },
      ]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: /^Shut this door/ }));
      fireEvent.click(await screen.findByRole("button", { name: /tap again to confirm/ }));

      expect(await screen.findByText(/Side door is shut\./)).toBeInTheDocument();
      expect(screen.queryByText(/Nothing changed/)).toBeNull();
    });

    /**
     * <b>C11, one screen along from the banner it was written about.</b>
     *
     * <p>
     * "Side door is shut. … Shut by Priya Naidoo on Mon 21 Sept, 18:34." is a STANDING fact,
     * and it sat in an assertive region on a page that re-reads itself every fifteen
     * seconds. The ruling is the same one the club-wide banner got: what is standing is
     * polite, and only a change somebody else caused earns an interruption. A shut door is
     * still a refusal in every other sense — it keeps its danger colour and its left rule.
     * </p>
     */
    it("states a standing shut politely rather than interrupting", async () => {
      openDoor([doorFixture({
        enabled: false, shut_by_name: "Priya Naidoo", out_of_service_since: new Date().toISOString(),
      })]);

      const notice = await screen.findByText(/Side door is shut/);
      expect(notice).toHaveAttribute("role", "status");
      // And it still LOOKS like a refusal: the finding is about what is announced over the
      // top of a reader, not about making a shut door look ordinary.
      expect(notice.className).toContain("border-danger-strong");
    });

    /**
     * <b>B10.</b> A tab left open overnight "shut" a door somebody else had already shut and
     * reported success — so the admin learned that their click had done something.
     */
    it("says nothing changed, and who it was, when the door was already shut", async () => {
      /*
        The stale tab, written as a stale tab.

        The version of this test that shipped reopened the door and shut it again and called
        the last press "stale" — but by then the door genuinely WAS open, so the PATCH did
        real work every time and `unchanged` was never exercised at all. It passed with the
        whole no-op branch deleted, which is the finding still shipping under a green test.

        What actually happens: this page read the club while the door was open, so it offers
        "Shut this door". Somebody else shut it in the meantime, so the PATCH changes nothing
        and answers with the CURRENT shut facts — who, and when.
      */
      const shutSince = new Date(Date.UTC(2026, 8, 19, 19, 48)).toISOString();
      const server = doorsServer([doorFixture({ enabled: true })]);
      const { stub } = { stub: stubFetch([
        settingsRoute(),
        ...server.routes,
        // Longer than the collection prefix, so it wins the stub's longest-prefix match.
        {
          method: "PATCH",
          path: `/api/v1/admin/devices/${DOOR_ID}`,
          respond: () => ({
            ...doorFixture({
              enabled: false, shut_by_name: "Priya Naidoo", out_of_service_since: shutSince,
            }),
            unchanged: true,
          }),
        },
      ]) };
      expect(stub).toBeTruthy();
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: /^Shut this door/ }));
      fireEvent.click(await screen.findByRole("button", { name: /tap again to confirm/ }));

      // The button returning to its other label is the same thing it does after real work,
      // so what the admin is TOLD is the whole fix.
      const told = await screen.findByText(/Nothing changed/);
      expect(told).toHaveTextContent("Side door was already shut");
      expect(told).toHaveTextContent("Priya Naidoo");
      // And never the success sentence — "Side door is shut." is a report of work done.
      expect(document.body.textContent).not.toContain("Side door is shut.");
    });

    /** C4: "Edit this door" and its Cancel both dropped focus to `<body>`. */
    it("keeps focus inside the door card across an edit and back", async () => {
      openDoor([doorFixture()]);

      const edit = await screen.findByRole("button", { name: "Edit Side door" });
      edit.focus();
      fireEvent.click(edit);

      // The editor takes focus to its first field rather than leaving it on a hidden button.
      await waitFor(() => expect(screen.getByLabelText("What the club calls it")).toHaveFocus());

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Edit Side door" })).toHaveFocus();
      });
    });
  });

  // --- W1.5, the fleet -----------------------------------------------------------

  describe("shutting every door", () => {
    it("is not rendered at all for a club with no doors", async () => {
      openDoors([]);

      await screen.findByText("No doors have called in yet.");
      expect(screen.queryByRole("button", { name: /Shut all doors/ })).toBeNull();
    });

    /**
     * <b>B3 / B5 at fleet scale.</b> The old confirm was 45 words describing every door as
     * both reachable and cut off at once, inside an 8-second auto-disarm. The doors a club
     * has are countable: when the club can reach all of them the sentence says so and stops.
     */
    it("says what it will do to the doors this club actually has", async () => {
      openDoors([doorFixture(), doorFixture({ id: OTHER_ID, name: "Front door", gate_key: "front-door" })]);

      fireEvent.click(await screen.findByRole("button", { name: /^Shut all doors — every door the club has open — 2 of 2/ }));
      const label = screen.getAllByText(/Shut all 2 doors\?/)[0];
      expect(label).toHaveTextContent("Every one of them opens for nobody from this click.");
      expect(label.textContent).not.toContain("admitting booked members");
      // The long version is still on the page, beside the control.
      expect(screen.getByText(/Shutting every door takes effect at the club's server at once/))
        .toHaveTextContent("for up to six hours");
    });

    it("counts the doors that cannot hear it, and only when there are some", async () => {
      openDoors([
        doorFixture(),
        doorFixture({
          id: OTHER_ID, name: "Front door", gate_key: "front-door",
          last_seen_at: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ]);

      fireEvent.click(await screen.findByRole("button", { name: /^Shut all doors/ }));
      expect(screen.getAllByText(/Shut all 2 doors\?/)[0]).toHaveTextContent(
        "1 cannot be reached and keeps admitting booked members from its saved list for six hours.",
      );
    });

    /** And an unreachable door with no name holds no list, so it is never said to admit anybody. */
    it("does not promise a cached list for an unnamed door that cannot be reached", async () => {
      openDoors([
        doorFixture(),
        doorFixture({
          id: OTHER_ID, name: "Door gate", gate_key: null,
          last_seen_at: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ]);

      fireEvent.click(await screen.findByRole("button", { name: /^Shut all doors/ }));
      const label = screen.getAllByText(/Shut all 2 doors\?/)[0];
      expect(label).toHaveTextContent("with no saved list it opens for nobody anyway");
      expect(label.textContent).not.toContain("admitting booked members");
    });

    /**
     * <b>The per-door confirmation — W1.5's whole point.</b> The server did the work
     * atomically; whether each DOOR knows is a separate fact, and a result that said "2 doors
     * shut" and stopped would be true of the database and false of the corridor.
     */
    it("shows a per-door result, confirmed and NOT CONFIRMED, with the power-loss line", async () => {
      openDoors([
        doorFixture({ last_seen_at: ago(12) }),
        doorFixture({ id: OTHER_ID, name: "Front door", gate_key: "front-door", last_seen_at: ago(6 * 3600), power_loss_behaviour: "released" }),
      ]);

      fireEvent.click(await screen.findByRole("button", { name: /^Shut .* — every door the club has open/ }));
      fireEvent.click(await screen.findByRole("button", { name: /tap again to confirm/ }));

      const heading = await screen.findByRole("heading", { name: /2 doors shut — 1 confirmed, 1 not/ });
      expect(heading).toHaveFocus();
      expect(screen.getByText(/confirmed — heard from 12s ago/)).toBeInTheDocument();
      const notConfirmed = screen.getByText(/NOT CONFIRMED — last heard/);
      expect(notConfirmed).toHaveTextContent("It may still admit booked members from its cached list for up to six hours.");
      expect(screen.getByText("With no power this door is: released.")).toBeInTheDocument();
      // The receipt carries the full sentence. The panel above it says the short form before
      // the click — two full copies on one 1280 screen read as a rendering fault, which is
      // what a look at the built page showed.
      expect(screen.getByText(/Getting out is mechanical and none of this touches it: the doors open/))
        .toBeInTheDocument();
      expect(screen.getByText(/Getting out of the building is mechanical/)).toBeInTheDocument();
    });

    /** Not-confirmed is a warning, not a danger: the action succeeded. */
    it("marks an unconfirmed door as NOT CONFIRMED in words", async () => {
      openDoors([doorFixture({ last_seen_at: ago(6 * 3600) })]);

      fireEvent.click(await screen.findByRole("button", { name: /^Shut .* — every door the club has open/ }));
      fireEvent.click(await screen.findByRole("button", { name: /tap again to confirm/ }));

      expect(await screen.findByText("NOT CONFIRMED")).toBeInTheDocument();
    });

    it("says nothing was shut when the server refuses, because it is one unit of work", async () => {
      const server = doorsServer([doorFixture()]);
      stubFetch([
        settingsRoute(),
        { method: "POST", path: "/api/v1/admin/doors/shut-all", status: 500, body: {} },
        ...server.routes,
      ]);
      renderPage(<AdminDoorsPage />);

      fireEvent.click(await screen.findByRole("button", { name: /^Shut .* — every door the club has open/ }));
      fireEvent.click(await screen.findByRole("button", { name: /tap again to confirm/ }));

      expect(await screen.findByText(/Nothing was shut/))
        .toHaveTextContent("every door is exactly as it was");
    });

    /**
     * <b>The partial state renders both controls.</b> Two of four shut is the state an admin
     * arrives in after an incident, and a single "Shut all doors" there would name a number
     * that is wrong.
     */
    /**
     * <b>C1 — the fleet Reopen exists only while a shut-all is standing.</b>
     *
     * It used to render whenever any door was shut, labelled from the club's TOTAL: "Reopen
     * all 3". But `reopen-all` reopens only what a shut-all shut, so an admin who had shut
     * one door on its own pressed it and got `{"doors": []}`, the words "0 doors reopened",
     * and no explanation whatever. The semantics are right and stay; the control now exists
     * only when it will do something, and the panel says where the way back actually is.
     */
    it("offers no fleet reopen for a door shut on its own, and says where to reopen it", async () => {
      openDoors([
        doorFixture(),
        doorFixture({ id: OTHER_ID, name: "Front door", gate_key: "front-door", enabled: false }),
      ]);

      expect(await screen.findByText("2 doors · 1 open, 1 shut")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Shut the 1 door still open — every door the club has open — 1 of 2/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Reopen the/ })).toBeNull();
      expect(screen.getByText(/Front door was shut on its own/))
        .toHaveTextContent("Reopen it from its own page");
    });

    /** And it DOES render, with the true count, once a shut-all is standing. */
    it("labels the fleet reopen with what it will actually reopen", async () => {
      openDoors([
        doorFixture({ shut_by_shut_all_at: ago(120), enabled: false }),
        doorFixture({
          id: OTHER_ID, name: "Front door", gate_key: "front-door", enabled: false,
          shut_by_shut_all_at: ago(120),
        }),
      ]);

      expect(await screen.findByRole("button", {
        name: /^Reopen the 2 doors shut together — every door the club shut together — 2/,
      })).toBeInTheDocument();
    });

    /**
     * <b>reopen-all reopens only what a shut-all shut.</b> A door an admin shut on its own
     * stays shut, or the club-wide control quietly undoes an individual decision.
     */
    it("leaves a door an admin shut individually shut", async () => {
      const { server, stub } = club([
        doorFixture(),
        doorFixture({ id: OTHER_ID, name: "Front door", gate_key: "front-door" }),
      ]);
      renderPage(<AdminDoorsPage />);

      // One door shut on its own, through the devices PATCH the door page uses.
      await screen.findAllByText("Reporting");
      await stub.calls.length;
      server.routes.find((r) => r.method === "PATCH")!.respond!({
        method: "PATCH", path: `/api/v1/admin/devices/${OTHER_ID}`, body: { enabled: false },
      });

      fireEvent.click(await screen.findByRole("button", { name: /^Shut .* — every door the club has open/ }));
      fireEvent.click(await screen.findByRole("button", { name: /tap again to confirm/ }));
      await screen.findByRole("heading", { name: /doors shut/ });

      fireEvent.click(await screen.findByRole("button", { name: /^Reopen the .* — every door the club shut together/ }));
      fireEvent.click(await screen.findByRole("button", { name: /tap again to confirm/ }));

      await waitFor(() => {
        const rows = server.current();
        expect(rows.find((d) => d.id === DOOR_ID)!.enabled).toBe(true);
        expect(rows.find((d) => d.id === OTHER_ID)!.enabled).toBe(false);
      });
    });
  });

  // --- the moved editing tests ---------------------------------------------------

  describe("naming a door (moved from the Devices page)", () => {
    it("saves a door's name and its door name together, as name and gate_key", async () => {
      const { stub } = club([doorFixture({ name: "Door gate", gate_key: null, auto_registered: true })]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      fireEvent.change(screen.getByLabelText("What the club calls it"), { target: { value: "Front door" } });
      fireEvent.change(screen.getByLabelText(/Name the board uses offline/), { target: { value: "front-door" } });
      fireEvent.click(screen.getByRole("button", { name: /Save this door/ }));

      await waitFor(() => {
        const patch = stub.calls.find((c) => c.method === "PATCH");
        expect(patch?.path).toBe(`/api/v1/admin/devices/${DOOR_ID}`);
        // A19: ONE form over all four writable fields, so ONE PATCH carrying all four. They
        // have always travelled on this same endpoint, so two forms and two saves bought
        // nothing and cost a hurried admin the ability to find the second half.
        // Still no court_numbers: the API refuses that field on a Gate row.
        expect(patch?.body).toEqual({
          name: "Front door",
          gate_key: "front-door",
          location_note: "",
          power_loss_behaviour: "not_established",
        });
        expect(patch?.raw).not.toContain("court_numbers");
      });
      expect(await screen.findByText(/Front door saved\. It is the front-door door/)).toBeInTheDocument();
    });

    it("trims the door name before sending it", async () => {
      const { stub } = club([doorFixture()]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      fireEvent.change(screen.getByLabelText(/Name the board uses offline/), { target: { value: "  front-door  " } });
      fireEvent.click(screen.getByRole("button", { name: /Save this door/ }));

      await waitFor(() => {
        expect(stub.calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ gate_key: "front-door" });
      });
    });

    /**
     * Clearing the field is `""` on the wire, not `null`. `null` means "leave the door's
     * name alone", so clearing a door name used to be a silent no-op that reported success —
     * and the test could not see it, because the PATCH route answered with an unnamed row
     * whatever it was sent. The assertion is on the OUTCOME: the row the server now holds.
     */
    it("clears a door name by sending an empty string, and the door really loses it", async () => {
      const { server, stub } = club([doorFixture({ name: "Front door", gate_key: "front-door" })]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      expect(screen.getByLabelText(/Name the board uses offline/)).toHaveValue("front-door");
      fireEvent.change(screen.getByLabelText(/Name the board uses offline/), { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: /Save this door/ }));

      await waitFor(() => {
        // `""`, not `null`: the API reads a null on this field as "leave it alone", which is
        // what the page used to send while reporting a success. `location_note` binds the
        // same two-valued way and rides the same PATCH (A19).
        expect(stub.calls.find((c) => c.method === "PATCH")?.raw)
          .toBe('{"name":"Front door","gate_key":"","location_note":"","power_loss_behaviour":"not_established"}');
      });
      await waitFor(() => expect(server.current()[0].gate_key).toBeNull());
      // The toast says what has actually been given up, rather than reporting a success that
      // reads as if the door were now named something: an unnamed door is sent an empty list,
      // so it stops working the moment it loses the network.
      expect(await screen.findByText(/Front door saved, and it has no door name\. Until you name this door/))
        .toHaveTextContent("only works while it can reach the server");
      // And the state paragraph agrees with it, which is the pair that has disagreed before.
      expect(screen.getByText(/It has no door name, so it is sent an empty list/)).toBeInTheDocument();
    });

    /** The API's own bound, on the field, so a long name is stopped where it is typed. */
    it("holds the door name to the 64 characters the API stores", async () => {
      openDoor([doorFixture()]);

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      expect(screen.getByLabelText(/Name the board uses offline/)).toHaveAttribute("maxLength", "64");
    });

    /** And the server's bound, refused by a mock that mirrors it rather than a canned 400. */
    it("refuses a door name past 64 characters at the server, not only at the keyboard", async () => {
      const { server } = club([doorFixture({ gate_key: "front-door" })]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      fireEvent.change(screen.getByLabelText(/Name the board uses offline/), { target: { value: "x".repeat(65) } });
      fireEvent.click(screen.getByRole("button", { name: /Save this door/ }));

      expect(await screen.findByText(/A door name is at most 64 characters/)).toBeInTheDocument();
      // A refused PATCH applies nothing.
      expect(server.current()[0].gate_key).toBe("front-door");

      fireEvent.change(screen.getByLabelText(/Name the board uses offline/), { target: { value: "y".repeat(64) } });
      fireEvent.click(screen.getByRole("button", { name: /Save this door/ }));
      await waitFor(() => expect(server.current()[0].gate_key).toBe("y".repeat(64)));
    });

    /**
     * A kind mismatch, which reaches a real admin one way: a row deleted and re-registered
     * as the other kind while their form was open.
     */
    it("says a door name belongs on a door when the row turned out to be a box", async () => {
      const server = doorsServer([deviceFixture({ id: DOOR_ID })]);
      stubFetch([settingsRoute(), ...server.routes]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      fireEvent.change(screen.getByLabelText(/Name the board uses offline/), { target: { value: "side-door" } });
      fireEvent.click(screen.getByRole("button", { name: /Save this door/ }));

      // A19 moved WHICH refusal this is: the one save now carries the door-card fields as
      // well as the name, and the API answers `door_fields_on_a_court_box` before it looks
      // at `gate_key`. That token had no copy at all and fell through to the raw string —
      // found by this test after the forms were merged, and fixed in `deviceErrors`.
      expect(await screen.findByText(/only a door has — and this row is a court box/))
        .toHaveTextContent(/delete the row and let it register itself again/);
      expect(screen.queryByText(/door fields on a court box/)).toBeNull();
      // The editor stays open, because the save did not go through.
      expect(screen.getByRole("button", { name: /Save this door/ })).toBeInTheDocument();
    });

    /**
     * The "New" badge is the API's to clear and it clears on any edit at all — so the setup
     * chip, which is keyed on the NAME, is what has to go away here, and it does because the
     * name is what was set.
     */
    it("drops the needs-a-name chip once the door is named", async () => {
      const { server } = club([doorFixture({ gate_key: null, auto_registered: true })]);
      renderPage(
        <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
        { initialEntries: [`/admin/doors/${DOOR_ID}`] },
      );

      expect(await screen.findByText("Needs a door name")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^Edit / }));
      fireEvent.change(screen.getByLabelText(/Name the board uses offline/), { target: { value: "front-door" } });
      fireEvent.click(screen.getByRole("button", { name: /Save this door/ }));

      await waitFor(() => expect(server.current()[0].auto_registered).toBe(false));
      await waitFor(() => expect(screen.queryByText("Needs a door name")).toBeNull());
    });

    /**
     * Why the field is worth filling in, and the claim it must NOT make: a gate decision is
     * recorded with the board's device code as well as its gate key, so the name is not the
     * only identifier — what is true is that the code is six hex digits of a MAC.
     */
    it("says why the door name matters without claiming it is the only identifier", async () => {
      openDoor([doorFixture()]);

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      const hint = screen.getByText(/Which door this board is on/);
      expect(hint).toHaveTextContent("this is how the record names the door");
      expect(hint).toHaveTextContent("Without it a scan is recorded against the board code alone");
      expect(hint).not.toHaveTextContent("only thing that tells one");
      expect(hint).toHaveTextContent("Leave it empty to take the name away again");
      expect(hint).toHaveTextContent("only works while it can reach the server");
    });

    /** No court list, no button map, no kind selector — the API refuses all three on a gate. */
    it("offers no court list, no button map and no kind selector", async () => {
      openDoor([doorFixture()]);

      fireEvent.click(await screen.findByRole("button", { name: /^Edit / }));
      expect(screen.queryByLabelText(/relay A court/)).toBeNull();
      expect(screen.queryByLabelText(/button /)).toBeNull();
      expect(screen.queryByLabelText(/kind/i)).toBeNull();
    });

    /**
     * A 64-character door name and a long device name are the two arbitrarily wide things on
     * this page, and this product has pushed itself wider than a phone on a long name before.
     */
    it("wraps a long name and a 64-character door name instead of widening the page", async () => {
      const longKey = "a".repeat(64);
      openDoor([doorFixture({
        name: "The changing room corridor door by the back staircase", gate_key: longKey,
      })]);

      const name = await screen.findByRole("heading", {
        name: "The changing room corridor door by the back staircase", level: 1,
      });
      expect(name.className).toContain("break-words");
      expect(name.className).toContain("min-w-0");
      const identity = screen.getAllByText(new RegExp(longKey))[0];
      expect(identity.className).toContain("break-words");
    });
  });
});

/**
 * <b>Round-3 findings on the door pages, each with the falsehood it closes.</b>
 *
 * <p>
 * These are deliberately in their own block rather than folded into the suite above: they are
 * a reviewer's findings against a rendered app, and keeping the reason beside the assertion is
 * what stops the next round "tidying" one of them back into the defect it replaced.
 * </p>
 */
describe("the door pages, round 3", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const settingsRoute = () => ({ path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE });

  const openDoor = (
    doors: Record<string, unknown>[],
    options: Parameters<typeof doorsServer>[1] = {},
    id = DOOR_ID,
  ) => {
    const server = doorsServer(doors, options);
    const stub = stubFetch([settingsRoute(), ...server.routes]);
    renderPage(
      <Routes><Route path="/admin/doors/:id" element={<AdminDoorsDetailPage />} /></Routes>,
      { initialEntries: [`/admin/doors/${id}`] },
    );
    return { server, stub };
  };

  /**
   * <b>R3-1 on the control itself.</b>
   *
   * The reopen confirm told an admin, about a board that had been served a 403 within one
   * heartbeat and had emptied its roster, that it "has been admitting booked members from its
   * saved list all along". Every input to that sentence came from an age the shut itself had
   * frozen.
   */
  it("does not tell an admin a door that HEARD the shut has been admitting people", async () => {
    openDoor([doorFixture({
      enabled: false,
      last_seen_at: new Date(Date.now() - 4000 * 1000).toISOString(),
      shut_heard_at: new Date(Date.now() - 3900 * 1000).toISOString(),
    })]);

    const control = await screen.findByRole("button", { name: /Reopen this door/ });
    fireEvent.click(control);

    // Two of them, and both are wanted: the armed consequence as page text, and the same
    // words in `ConfirmButton`'s live region so the sentence is heard as well as read.
    expect((await screen.findAllByText(/was told of the shut and has been opening for nobody/)).length)
      .toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("admitting booked members");
    // And the standing notice above it says the same thing, with the instant it happened.
    expect(document.body.textContent).toContain("Confirmed: this door heard the shut at");
  });

  it("says it cannot tell, where the API has not said", async () => {
    openDoor([doorFixture({
      enabled: false,
      last_seen_at: new Date(Date.now() - 4000 * 1000).toISOString(),
    })]);

    // Not "it has not been told" — that was a conclusion from a frozen age — and not
    // "confirmed" either. The page says which of the two it does not know.
    expect(await screen.findByText(/this page cannot say whether it was told/))
      .toBeInTheDocument();
  });

  /**
   * <b>C-C2 / R3-10 — confirming the most consequential action on the surface dropped focus
   * to `&lt;body&gt;`.</b>
   *
   * The two branches of the control are different elements, so the state change an admin has
   * just caused unmounts the very control they pressed. A keyboard user was returned to the
   * top of the document with nothing announced.
   */
  it("leaves focus on the new state's control after a shut is confirmed", async () => {
    openDoor([doorFixture()]);

    fireEvent.click(await screen.findByRole("button", { name: /Shut this door/ }));
    fireEvent.click(await screen.findByRole("button", { name: /tap again to confirm/ }));

    const reopen = await screen.findByRole("button", { name: /Reopen this door/ });
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(reopen).toHaveFocus();
  });

  /**
   * <b>A-M3 / B12 / R3-21 — one unnamed door had three names on one surface.</b>
   *
   * The tile that links here said "Unnamed scanner (gate-0a1b2c)", this heading said "Door
   * gate" — the registration placeholder, which is identical for every unnamed board in the
   * club — and the line under it said "no door name yet".
   */
  it("calls an unnamed door the same thing in the heading as everywhere else", async () => {
    openDoor([doorFixture({ name: "Door gate", gate_key: null, device_code: "gate-0a1b2c" })]);

    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Unnamed scanner (gate-0a1b2c)");
    expect(heading.textContent).not.toBe("Door gate");
  });

  /**
   * <b>A2 / B2 / R3-15 — clearing the name reported success and changed nothing.</b>
   *
   * The editor substituted the existing name for an empty field before sending, so the PATCH
   * carried the name the admin had just deleted. The screen said "saved".
   */
  it("really clears a door's name when the field is emptied", async () => {
    const { server, stub } = openDoor([doorFixture({ name: "Side door" })]);

    fireEvent.click(await screen.findByRole("button", { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText("What the club calls it"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save this door" }));

    await waitFor(() => {
      const patch = stub.calls.filter((c) => c.method === "PATCH").at(-1);
      expect((patch?.body as { name?: string }).name).toBe("");
    });
    await waitFor(() => expect(server.current()[0].name).toBeNull());
  });

  it("stops a name at the length the column actually stores", async () => {
    openDoor([doorFixture()]);

    fireEvent.click(await screen.findByRole("button", { name: /Edit/ }));
    // A2 / B2: over it, the API answered 500 with the EF exception in it.
    expect(screen.getByLabelText("What the club calls it")).toHaveAttribute("maxLength", "128");
  });

  /**
   * <b>A-M6 / R3-14 — the printed card said the club's doors could not be read.</b>
   *
   * A read that LANDED and found no such door is not a failed read, and telling an admin
   * following a stale link that the doors are unreadable sends them to look for an outage.
   */
  it("tells a stale card link the door is gone, not that the doors could not be read", async () => {
    const server = doorsServer([doorFixture()]);
    stubFetch([settingsRoute(), ...server.routes]);
    renderPage(
      <Routes><Route path="/admin/doors/:id/card" element={<AdminDoorsCardPage />} /></Routes>,
      { initialEntries: ["/admin/doors/11111111-1111-1111-1111-111111111111/card"] },
    );

    expect(await screen.findByText(/That door is not on the club's list/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("The doors could not be read");
  });
});
