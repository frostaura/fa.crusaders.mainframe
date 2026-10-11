import { describe, expect, it, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import MyCodePage from "./MyCode";
import { encodeQr, qrPath } from "../lib/qr";
import {
  MEMBER_CODE_FIXTURE,
  memberCodeRoutes,
  memberDoorBookingFixture,
  memberDoorDecisionFixture,
  memberDoorFixture,
  memberDoorNotActiveFixture,
  memberDoorOfflineDecisionFixture,
  memberDoorsOnFixture,
  refuse,
  renderPage,
  signOut,
  stubFetch,
  type StubRoute,
  unreachable,
} from "../test/harness";
import { forgetLastKnown, rememberDoor } from "../lib/lastKnown";
import { fromHex, importHmacKey, isSoftHmacKey } from "../lib/memberCode/hotp";
import { loadMemberCode, saveMemberCode } from "../lib/memberCode/keyStore";
import { GATE_ROSTER_MAX_ENTRIES } from "../lib/gateCopy";
import { MY_CODE } from "../lib/myCodeCopy";
import { OFFLINE_COPY } from "../lib/offline/offlineCopy";

/**
 * Waits, in REAL time, for the code to be on the pass.
 *
 * <p>
 * WebCrypto answers from Node's thread pool, not from the microtask queue, so under fake timers
 * neither `advanceTimersByTimeAsync` nor a `findBy` (whose polling is itself a faked timeout)
 * lets an enrolment's key import and first HMAC land. `setImmediate` is never faked here, and a
 * turn of the real event loop is exactly what those calls need.
 * </p>
 */
async function codeOnScreen(): Promise<HTMLElement> {
  for (let i = 0; i < 500; i++) {
    const code = screen.queryByLabelText("Your code");
    if (code) return code;
    await act(async () => { await new Promise((r) => setImmediate(r)); });
  }
  throw new Error("the code never reached the pass");
}

/**
 * My Code — the ONE rotating member code (D1).
 *
 * <p>
 * <b>Retired under D1, with this note rather than silently.</b> This describe used to hold the
 * two-code page's lifecycle: the booking/member tabs, the walk-up choice and its session memory,
 * the pre-fetch before a code died, the not-rotated chase and its pacing, the dead-code states,
 * the cached booking code offered in place of a dead one, and the offline page's remembered
 * code. D1 replaced both codes with one made on the phone every thirty seconds from a key it
 * holds, so none of that machinery exists — there is no code to fetch, none that can die, and no
 * second one to switch to. (`components/member-door/code-tabs.test.tsx` went for the same reason.)
 * What is asserted instead is the new contract: enrol, re-enrol on a moved generation, the key
 * never readable, the code from the corpus, rotation at the step, the offline badge, the
 * first-visit-needs-signal state, the bar, and the full-screen view.
 * </p>
 */
describe("MyCode — the one rotating code", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    forgetLastKnown();
    signOut();
  });

  const EMPTY_DOOR = memberDoorFixture();

  /** At the corpus anchor, 17 s into step 59672640 — so the token is `derivation.json`'s. */
  const atAnchor = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MEMBER_CODE_FIXTURE.anchorMs));
  };

  function renderWith(extra: StubRoute[] = [], options: Parameters<typeof memberCodeRoutes>[0] = {}) {
    const stub = stubFetch([...memberCodeRoutes(options), { path: "/api/v1/me/door", body: EMPTY_DOOR }, ...extra]);
    renderPage(<MyCodePage />);
    return stub;
  }

  const enrols = (stub: { calls: { method: string; path: string }[] }) =>
    stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/me/code/enrol").length;
  const statusReads = (stub: { calls: { method: string; path: string }[] }) =>
    stub.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/me/code").length;

  /** A key already on this phone, for the signed-in fixture member. */
  async function seedKey(generation = 1, userId = "44444444-4444-4444-4444-444444444444") {
    await saveMemberCode({
      key: await importHmacKey(fromHex(MEMBER_CODE_FIXTURE.secretHex)),
      ref: MEMBER_CODE_FIXTURE.ref, generation, tz: MEMBER_CODE_FIXTURE.tz, offsetMs: 0, userId, enrolledAt: 0,
    });
  }

  it("enrols on the first visit and shows the corpus token on the pass", async () => {
    atAnchor();
    const stub = renderWith();
    expect(await screen.findByLabelText("Your code")).toHaveTextContent(MEMBER_CODE_FIXTURE.anchorToken);
    expect(screen.getByRole("article", { name: "Your member pass" })).toBeInTheDocument();
    expect(enrols(stub)).toBe(1);
    expect(statusReads(stub)).toBe(0);
  });

  /**
   * Plain `http://` to the club's LAN server is not a secure context, so the browser gives the page
   * `crypto` with no `subtle`. The pass still shows the corpus token — made with the soft key — and
   * the key it enrolled is the fallback, kept on this phone like any other.
   */
  it("enrols and shows the corpus token on a page with no WebCrypto (crypto.subtle absent)", async () => {
    atAnchor();
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    expect(globalThis.crypto.subtle).toBeUndefined();
    const stub = renderWith();
    expect(await screen.findByLabelText("Your code")).toHaveTextContent(MEMBER_CODE_FIXTURE.anchorToken);
    expect(enrols(stub)).toBe(1);
    expect(isSoftHmacKey((await loadMemberCode())?.key)).toBe(true);
  });

  /** The QR carries the bare 19-character token — nothing around it, or the box poisons the scan. */
  it("encodes the bare token and nothing else", async () => {
    atAnchor();
    renderWith();
    const qr = await screen.findByRole("img", { name: `QR code ${MEMBER_CODE_FIXTURE.anchorToken}` });
    expect(qr.querySelector("path")!.getAttribute("d")).toBe(qrPath(encodeQr(MEMBER_CODE_FIXTURE.anchorToken), 4));
  });

  it("prints the code in groups a member can read, while its text stays the unbroken token", async () => {
    atAnchor();
    renderWith();
    const code = await screen.findByLabelText("Your code");
    const groups = [...code.querySelectorAll(":scope > span > span")].map((s) => s.textContent);
    expect(groups).toEqual(["118Y9", "5600", "8441", "714", "835"]);
    expect(code.textContent).toBe(MEMBER_CODE_FIXTURE.anchorToken);
  });

  it("counts the step down beside a ring, in seconds", async () => {
    atAnchor();
    renderWith();
    await screen.findByLabelText("Your code");
    // 17 s into the step: 13 left.
    expect(screen.getByText("New code in 13 seconds")).toBeInTheDocument();
    expect(document.querySelector("[data-countdown-ring]")).toHaveAttribute("aria-hidden", "true");
  });

  it("turns to the next step's code at the boundary, with no request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(MEMBER_CODE_FIXTURE.anchorMs));
    const stub = renderWith();
    expect(await codeOnScreen()).toHaveTextContent(MEMBER_CODE_FIXTURE.anchorToken);
    const calls = stub.calls.length;
    for (let i = 0; i < 14; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    // `derivation.json` dean-gen1 "anchor+30s": the next step, made on the phone.
    for (let i = 0; i < 500 && !screen.getByLabelText("Your code").textContent?.startsWith("118Y92543"); i++) {
      await act(async () => { await new Promise((r) => setImmediate(r)); });
    }
    expect(screen.getByLabelText("Your code")).toHaveTextContent("118Y925437688407038");
    expect(stub.calls.slice(calls).filter((c) => c.path.startsWith("/api/v1/me/code"))).toHaveLength(0);
  });

  /** The secret is on the wire once and never anywhere a script or a person could read it back. */
  it("keeps the secret as a non-extractable key and writes none of it to localStorage", async () => {
    renderWith();
    await screen.findByLabelText("Your code");
    const record = await loadMemberCode();
    expect((record!.key as CryptoKey).extractable).toBe(false);
    expect((record!.key as CryptoKey).usages).toEqual(["sign"]);
    const everything = Object.keys(window.localStorage).map((k) => window.localStorage.getItem(k)).join("|");
    expect(everything).not.toContain(MEMBER_CODE_FIXTURE.secretHex);
    expect(everything).not.toMatch(/rOXp1nGO4hw0Pe6QnpA3_5jUfb8FPf-le5sk2cmbU4c/);
    expect(JSON.stringify(record)).not.toContain(MEMBER_CODE_FIXTURE.secretHex);
  });

  it("refreshes its clock without re-enrolling when the club's generation has not moved", async () => {
    await seedKey(1);
    const stub = renderWith();
    await screen.findByLabelText("Your code");
    await waitFor(() => expect(statusReads(stub)).toBe(1));
    expect(enrols(stub)).toBe(0);
  });

  /** A password change, a suspension, an admin reset or sign-out-everywhere bumps it (§10). */
  it("re-enrols when the club says the generation moved", async () => {
    await seedKey(1);
    const stub = renderWith([], { generation: 2 });
    await waitFor(() => expect(enrols(stub)).toBe(1));
    await waitFor(async () => expect((await loadMemberCode())?.generation).toBe(2));
  });

  it("never shows a key stored for a different member, and enrols its own", async () => {
    await seedKey(1, "99999999-9999-9999-9999-999999999999");
    const stub = renderWith();
    await screen.findByLabelText("Your code");
    expect(enrols(stub)).toBe(1);
    expect((await loadMemberCode())?.userId).toBe("44444444-4444-4444-4444-444444444444");
  });

  it("shows the code from the key on this phone, with a badge, when the club cannot be reached", async () => {
    atAnchor();
    await seedKey(1);
    renderWith([], { status: unreachable("/api/v1/me/code") });
    expect(await screen.findByLabelText("Your code")).toHaveTextContent(MEMBER_CODE_FIXTURE.anchorToken);
    // R15 X15-3 — the phone says it has signal (jsdom's onLine is true): the club is unreachable.
    expect(await screen.findByText(OFFLINE_COPY.unreachableBadge)).toBeInTheDocument();
  });

  it("R15 X15-3 — with the phone itself offline the badge says Offline", async () => {
    atAnchor();
    await seedKey(1);
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderWith([], { status: unreachable("/api/v1/me/code") });
    expect(await screen.findByText(MY_CODE.offlineBadge)).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("R15 X15-3 — no key, the phone offline: the first visit needs signal", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderWith([], { enrol: unreachable("/api/v1/me/code/enrol", "POST") });
    expect(await screen.findByRole("heading", { name: MY_CODE.needsSignal.title })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("says the first visit needs the club when there is no key and the club can't be reached (phone online)", async () => {
    const stub = renderWith([], { enrol: unreachable("/api/v1/me/code/enrol", "POST") });
    expect(await screen.findByRole("heading", { name: MY_CODE.needsClub.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: MY_CODE.needsSignal.title })).toBeNull();
    expect(screen.queryByLabelText("Your code")).toBeNull();
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(enrols(stub)).toBe(2));
  });

  it("says the club has no member codes yet on a server that predates them", async () => {
    renderWith([], { enrol: { respond: undefined, status: 404, body: { error: "not_found" } } });
    expect(await screen.findByText(/hasn't switched on member codes yet/)).toBeInTheDocument();
  });

  it("refuses an enrolment it cannot use, and stores nothing", async () => {
    renderWith([], {
      enrol: {
        respond: () => ({ v: 1, ref: "18Y9", generation: 1, secret: "AAAA", tz: "Africa/Johannesburg", step_seconds: 60, server_time_ms: Date.now() }),
      },
    });
    expect(await screen.findByText(/Couldn't set up your code/i)).toBeInTheDocument();
    expect(await loadMemberCode()).toBeNull();
  });

  /** The club has said no: no code, the key wiped, one control — and it brings the page back. */
  it("replaces the page for a barred member, wipes the key, and lets them check again", async () => {
    await seedKey(1);
    const stub = renderWith([], {
      generation: 2,
      enrol: { respond: undefined, status: [403, 200], body: {}, sequence: [{ error: "member_suspended" }, undefined] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/membership is suspended/i);
    expect(screen.queryByLabelText("Your code")).toBeNull();
    expect(await loadMemberCode()).toBeNull();
    expect(enrols(stub)).toBe(1);
  });

  it("brings the code back when the member checks again after the bar is lifted", async () => {
    let barred = true;
    const base = memberCodeRoutes();
    const enrol = base.find((r) => r.path === "/api/v1/me/code/enrol")!;
    const real = enrol.respond!;
    stubFetch([
      ...base.filter((r) => r !== enrol),
      { ...enrol, respond: (req) => (barred ? refuse(403, { error: "member_not_active" }) : real(req)) },
      { path: "/api/v1/me/door", body: EMPTY_DOOR },
    ]);
    renderPage(<MyCodePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/isn't active yet/i);
    barred = false;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByLabelText("Your code")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("has one code: no tabs, and never asks for a legacy code", async () => {
    const stub = renderWith();
    await screen.findByLabelText("Your code");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(stub.calls.some((c) => c.path.includes("/qr/generate"))).toBe(false);
  });

  it("opens full screen with the same token, its countdown and a brightness hint, and gives focus back on close", async () => {
    atAnchor();
    renderWith();
    const trigger = await screen.findByRole("button", { name: "Show your code full screen" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: /full screen/i });
    expect(within(dialog).getByRole("img", { name: `QR code ${MEMBER_CODE_FIXTURE.anchorToken}` })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(MEMBER_CODE_FIXTURE.anchorToken);
    expect(dialog).toHaveTextContent("New code in 13 seconds");
    expect(dialog).toHaveTextContent(/brightness up/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show your code full screen" })));
  });

  /** D5 — code surfaces never carry the fingerprint watermark. */
  it("draws no watermark on the pass", async () => {
    renderWith();
    await screen.findByLabelText("Your code");
    const pass = screen.getByRole("article", { name: "Your member pass" });
    expect(pass.querySelector("[data-wm-glyph]")).toBeNull();
  });
});

/**
 * The same page, at a club that has a door.
 *
 * <p>
 * Everything above this line is about a court box and none of it changes. What follows
 * is the other half of what these twelve characters do: let the holder into the
 * building. The person every case here is settled by is a member outside a locked door
 * at 06:00, in the dark, one hand on the phone, one bar of signal, with nobody to ask.
 * </p>
 *
 * <p>
 * The wave-1 wire shape is thinner than the design assumed — no `is_club_admin`, no
 * `early_entry_minutes`, no `offline` flag on a decision, no `opens_at` — so these tests
 * are written to what the server actually sends. Where a sentence would have carried a
 * number the response does not include, the assertion is that the page does not invent
 * one.
 * </p>
 */
describe("MyCode at a club with a door", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    forgetLastKnown();
    signOut();
  });

  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  const CODE = {
    code: "7K3M9XQ2RD5A",
    kind: "booking",
    expires_in_seconds: 900,
    court_number: 3,
    starts_at: "2026-09-19T17:00:00Z",
    doors: true,
    door_opens_at: "2026-09-19T16:30:00Z",
    door_closes_at: "2026-09-19T18:05:00Z",
  };

  const IDENT_CODE = { code: "ZZ9P4T6WQ8HN", kind: "ident", expires_in_seconds: 60, doors: true };

  const BOOKING = memberDoorBookingFixture();

  /** Renders with both reads answered. `door` is the whole `/me/door` document. */
  /** `GET /me/door/history` with nothing in it — what the self-check reads by default. */
  const EMPTY_HISTORY = {
    items: [], next_cursor: null, retention_days: 90, timezone: "Africa/Johannesburg",
  };

  /**
   * `_code` is the legacy code a call site used to hand the generate route. D1: there is one
   * code, enrolled from `memberCodeRoutes`, so the argument is accepted and ignored — every
   * call that passed a booking or an ident code now renders the single code.
   */
  function renderBoth(door: Record<string, unknown>, _code?: unknown) {
    const stub = stubFetch([
      ...memberCodeRoutes(),
      { path: "/api/v1/me/door", body: door },
      // E-H2 (2) — the self-check reads the club's own record when the member presses the
      // button. Stubbed EMPTY by default, and stubbed at all deliberately: `/me/door` is a
      // prefix of `/me/door/history`, so without a route of its own the history request was
      // answered with the door object and the page spread an `items` that was not there.
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);
    return stub;
  }

  // --- doors: false is SILENCE, not a smaller version of the door page ----------------

  /**
   * The silent half, and the one that is easiest to break by adding a block and
   * forgetting its guard. A club with no gate must not meet the word at all — not in a
   * standing line, not in a control, not in a footer.
   */
  it("says nothing whatever about doors at a club that has none", async () => {
    renderBoth(memberDoorFixture(), { ...CODE, doors: false, door_opens_at: null, door_closes_at: null });

    await screen.findByLabelText("Your code");
    await waitFor(() => expect(screen.queryByText(/Getting your code/)).toBeNull());
    expect(document.body.textContent).not.toMatch(/door/i);
    expect(screen.queryByRole("button", { name: "The door didn't open" })).toBeNull();
  });



  // --- W1.7a, the standing line ---------------------------------------------------------

  it("names the booking and the hour the door starts opening, under the booking-window rule", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));

    expect(await screen.findByText("What opens the door for you right now")).toBeInTheDocument();
    expect(screen.getByText(/the door opens for you (from|now)/)).toBeInTheDocument();
  });

  it("states the active-member rule with no clock time for a door", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "active_member", membership: "active" }));

    const line = await screen.findByText(/Your club opens its doors for any active member/);
    expect(line).toHaveTextContent(/Yours is active/);
    expect(line.textContent).not.toMatch(/\d{2}:\d{2}/);
  });

  /**
   * The de-duplication rule. `describeDoor()` and the standing line are fed by different
   * requests and say the same thing with different confidence; rendered together they are
   * a screen stating one fact twice, the second time more vaguely.
   */
  it("states the door window exactly once when both sources have it", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));

    await screen.findByLabelText("Your code");
    await waitFor(() => expect(screen.getByText("What opens the door for you right now")).toBeInTheDocument());
    const said = document.body.textContent ?? "";
    expect(said.split("It also opens the club door from")).toHaveLength(1);
  });

  /**
   * The screen must not argue with itself, which is the whole reason one response carries
   * both blocks.
   *
   * <p>
   * Found by looking at the rendered page, not by reading the design: a member the club
   * has as not active read "no code of yours opens a door until they change that" with
   * "It also opens the club door from 20:54 until 22:29." a centimetre above it, because
   * the suppression rule keyed on the standing line having a CLOCK WINDOW and this arm
   * has none. The rule is the contradiction, not the duplication.
   * </p>
   */
  it("never promises a door window over a sentence saying no door will open", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", membership: "not_active", next_booking: BOOKING }));

    await screen.findByText(/no code of yours opens a door until they change that/);
    expect(screen.queryByText(/It also opens the club door/)).toBeNull();
  });

  it("says the same for a member with nothing booked, whose code claims the club's rules allow it", async () => {
    renderBoth(
      memberDoorsOnFixture({ policy: "booking_window", membership: "active", next_booking: null }),
      { code: "ZZ9P4T6WQ8HN", kind: "ident", expires_in_seconds: 60, doors: true },
    );

    await screen.findByText(/a door won't open for you/);
    expect(screen.queryByText(/It also opens the club door/)).toBeNull();
  });




  /**
   * A cached sentence rendered as though it were fresh is worse than no sentence: a
   * screen telling a member what their club's doors need, from a reading that may be
   * hours old, with nothing to say so.
   */
  it("says how old the door facts are when it is serving them from the last good read", async () => {
    rememberDoor(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) as never);
    stubFetch([
      ...memberCodeRoutes(),
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);

    const said = await screen.findByText(/ago it said/);
    // A 500 from the club: the cached sentence still travels with its age, but the lead
    // names the club's system rather than this member's phone.
    expect(said).toHaveTextContent(/answered with an error/);
    expect(said).toHaveTextContent(/a court booked/);
    expect(said).toHaveTextContent(/That may have changed since/);
  });

  /**
   * The offline half, served from the cache, still carries the CLUB's cap.
   *
   * <p>
   * The one reading where getting it wrong matters most: this sentence is about what
   * happens when a door is cut off, and it is being shown to somebody whose phone is cut
   * off too. Falling back to the shared constant here would print 48 at a club whose
   * boards hold twelve — which is the page guessing on the one screen where it has a
   * stored answer and a member has no way to check.
   * </p>
   */
  it("keeps the club's own roster cap when the standing line comes from the cache", async () => {
    rememberDoor(memberDoorsOnFixture({
      policy: "booking_window", next_booking: BOOKING, roster_max_entries: 12,
    }) as never);
    stubFetch([
      ...memberCodeRoutes(),
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);

    const summary = await screen.findByText("What if the door is offline?");
    fireEvent.click(summary);
    const body = screen.getByText(/decides from a list of bookings/);
    expect(body).toHaveTextContent(/next 12 bookings/);
    expect(body).not.toHaveTextContent(new RegExp(`first ${GATE_ROSTER_MAX_ENTRIES} bookings`));
  });

  /** And with nothing cached, a different sentence — three silences, three sentences. */
  it("says it cannot tell the member anything when there is no cached copy either", async () => {
    stubFetch([
      ...memberCodeRoutes(),
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);

    const said = await screen.findByText(/can't tell you what its doors need/);
    expect(said.textContent).not.toMatch(/ago it said/);
  });

  it("states the offline half of the conditional, with the roster cap it was given", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));

    const summary = await screen.findByText("What if the door is offline?");
    fireEvent.click(summary);
    const body = screen.getByText(/decides from a list of bookings/);
    expect(body).toHaveTextContent(String(GATE_ROSTER_MAX_ENTRIES));
    expect(body).toHaveTextContent(/bookings/);
    expect(body.textContent).not.toMatch(/lockdown|attendance/i);
  });

  // --- W1.7b, the decision card -----------------------------------------------------------

  it("tells a member the club has their membership as not active, and gives them the number", async () => {
    renderBoth(memberDoorsOnFixture({
      membership: "not_active",
      last_decision: memberDoorDecisionFixture({ reason: "member_not_active" }),
    }));

    // ONE match. The visible line and the screen-reader twin are only split when they
    // DIFFER — which is when a countdown is ticking in one of them. On an arm with no
    // countdown, two copies inside an atomic live region is the sentence read out twice.
    expect((await screen.findAllByText(/The club has your membership as not active\./)).length).toBe(1);
    // D6 appended the age to the stamp.
    expect(screen.getByText(/^front-door · \d{2}:\d{2} · just now$/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Call the club" })[0]).toHaveAttribute("href", "tel:0215550134");
  });

  /**
   * `too_early` is a clock fact, not a fault. The contract says it in as many words: no
   * error styling. So the card carries an `info` tone, and NOTHING in it is a `danger`
   * class or an assertive alert.
   */
  it("counts a too-early member down without dressing it as an error", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:02:48Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: BOOKING,
      last_decision: memberDoorDecisionFixture({ at: "2026-09-19T16:02:00Z", reason: "too_early" }),
    }));
    await advance(0);

    const card = screen.getByRole("status");
    expect(card).toHaveTextContent(/Too early — the door opens for you in 27m 12s\./);
    expect(card.querySelector(".text-danger-strong")).toBeNull();
    expect(card.querySelector("[role='alert']")).toBeNull();
    // The CHROME as well as the text. A calm sentence inside a red rule still reads as a
    // fault from two metres away, which is the whole of what "no error styling" means.
    expect(card.className).toContain("border-info-strong");
    expect(card.className).not.toContain("danger");

    // It counts DOWN, off the clock, not up from a tick counter.
    await advance(5_000);
    expect(card).toHaveTextContent(/27m 07s/);
  });

  it("says the door opens now when the window arrives, and does not change tone", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:29:58Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: BOOKING,
      last_decision: memberDoorDecisionFixture({ at: "2026-09-19T16:29:00Z", reason: "too_early" }),
    }));
    await advance(0);
    await advance(3_000);

    const card = screen.getByRole("status");
    expect(card).toHaveTextContent(/The door opens for you now\./);
    expect(card.querySelector(".text-danger-strong")).toBeNull();
  });

  /**
   * Both sources of a countdown absent at once: no `opens_at` on the decision, and no
   * booking in the same document. That is what the endpoint sends when the booking behind
   * the refusal has since been cancelled — `TooEarlyOpensAtAsync` returns null — and the
   * card says so rather than counting down to a time nobody sent.
   */
  it("states too early with no countdown when the server sent no window", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: null,
      last_decision: memberDoorDecisionFixture({ reason: "too_early" }),
    }));

    const card = await screen.findByRole("status");
    expect(card).toHaveTextContent(/Too early — the door hadn't opened for you yet\./);
    expect(card.textContent).not.toMatch(/\d+m \d+s/);
  });

  it("offers a court to book when the door wanted one", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      last_decision: memberDoorDecisionFixture({ reason: "no_booking" }),
    }));

    /*
      ONE of them, and this assertion used to say `toBeGreaterThan(0)`.

      The decision card and the standing line were both offering it, because the refusal says
      "you had no booking" and the standing rule says "this club wants one" — the same act,
      told twice, as two identical filled brand-coloured buttons a few hundred pixels apart on
      a phone. A member outside a locked door reads that as two different things they have not
      understood. The card is the EVENT and outranks the rule while it is on screen; dismiss
      it and the standing line's offer comes back, which the case below this one asserts.
    */
    const books = await screen.findAllByRole("link", { name: "Book a court" });
    expect(books).toHaveLength(1);
    expect(books[0]).toHaveAttribute("href", "/bookings") // R15: Bookings lives at /bookings;
  });

  /**
   * The dead-code arm, and the two things it must not do: say "no refusals found", and
   * make the member ask for the fresh code the page can fetch on its own.
   */
  it("fetches a fresh code by itself when the door said the last one was not live", async () => {
    const stub = renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "not_recognised" }),
    }));

    // One match, for the reason the not-active test above carries in full: the split is
    // a countdown affordance, and this arm has no countdown.
    expect((await screen.findAllByText(/That code wasn't live any more\./)).length).toBe(1);
    // D1: "not live" can mean the key on this phone was rotated, so the page checks with the
    // club by itself (the mount's exchange or one of its own), and the card's button asks again.
    await screen.findByLabelText("Your code");
    const reads = () => stub.calls.filter((c) => c.path.startsWith("/api/v1/me/code")).length;
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1));
    const before = reads();
    fireEvent.click(screen.getByRole("button", { name: "Refresh the code" }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(document.body.textContent).not.toMatch(/no refusal|nothing to show|no recent/i);
  });

  /**
   * D7. It said "a door the club hasn't named yet", which is an admin fact a member
   * cannot act on — and which contradicted the same member's own history, where a named
   * door's offline rows were arriving with the name stripped and being labelled the same
   * way beside releases the offline disclosure says such a door cannot make.
   */
  it("calls a door this response carried no name for a club door", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ door_name: null, reason: "no_booking" }),
    }));

    expect(await screen.findByText(/^a club door · \d{2}:\d{2} · just now$/)).toBeInTheDocument();
    expect(screen.queryByText(/hasn't named/i)).toBeNull();
  });

  /** The claim probe, on the card that is most tempting to over-promise. */
  it("makes no claim about a door moving, or about anyone arriving", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "ok", released: true }),
    }));

    const card = await screen.findByRole("status");
    const said = card.textContent ?? "";
    expect(said).toMatch(/lock released/i);
    for (const banned of ["attendance", "checked in", "marks you as arrived", "lights", "relay", "lockdown"]) {
      expect(said.toLowerCase()).not.toContain(banned);
    }
  });

  /**
   * The a11y contract, which is done once or done wrong. The visible digits change every
   * second; a live region that reads them is a screen reader talking over a member's own
   * thoughts for as long as they stand there.
   */
  it("hides the ticking digits from the accessibility tree and speaks in whole minutes", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:02:48Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: BOOKING,
      last_decision: memberDoorDecisionFixture({ at: "2026-09-19T16:02:00Z", reason: "too_early" }),
    }));
    await advance(0);

    const card = screen.getByRole("status");
    expect(card).toHaveAttribute("aria-live", "polite");
    const ticking = screen.getByText(/27m 12s/);
    expect(ticking).toHaveAttribute("aria-hidden", "true");
    expect(card.querySelector(".sr-only")?.textContent).toMatch(/27 minutes/);
    expect(document.querySelector("[aria-live='assertive']")).toBeNull();
  });

  /**
   * Two minutes is the SERVER's fetch window, not a display window.
   *
   * <p>
   * The poll is DRIVEN here rather than assumed: the second answer has the row gone —
   * which is what the endpoint does after 120 seconds — and the card must still be on
   * screen, because one that vanishes mid-sentence while a cold member reads it is the
   * defect this rule exists to prevent. Only the member, or a newer decision, takes it
   * away.
   * </p>
   */
  it("keeps the card when the server stops sending the row, and drops it when the member says so", async () => {
    fakeClock();
    const first = memberDoorDecisionFixture({ at: "2026-09-19T06:04:00Z", reason: "no_booking" });
    const stub = stubFetch([
      ...memberCodeRoutes(),
      {
        path: "/api/v1/me/door",
        body: {},
        sequence: [
          memberDoorsOnFixture({ last_decision: first }),
          memberDoorsOnFixture({ last_decision: null }),
        ],
      },
    ]);
    renderPage(<MyCodePage />);
    await advance(0);

    expect(screen.getByRole("status")).toHaveTextContent(/The door needs a court booked\./);

    // The next poll lands, and the row is gone from the response.
    await advance(6_000);
    expect(stub.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/me/door").length)
      .toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("status")).toHaveTextContent(/The door needs a court booked\./);

    // The member's own Dismiss does take it away — and a later poll does not hand it
    // straight back, which is the other half of the same rule.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await advance(0);
    expect(screen.queryByRole("status")).toBeNull();
    await advance(31_000);
    expect(screen.queryByRole("status")).toBeNull();
  });

  /**
   * A3.1: the control is PERMANENT, not something a refusal reveals. The commonest
   * refusal of all — an unknown or malformed token — names nobody and can therefore never
   * arrive by polling, so a member who has just been refused still needs the way in.
   */
  it("keeps the way in on screen even while a refusal card is showing", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "no_booking" }),
    }));

    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: "The door didn't open" })).toBeEnabled();
  });

  it("shows nothing at all when the member has no decision, and still offers the way in", async () => {
    renderBoth(memberDoorsOnFixture({ last_decision: null }));

    await screen.findByLabelText("Your code");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "The door didn't open" })).toBeEnabled();
    expect(document.body.textContent).not.toMatch(/no refusal|nothing to show|no recent/i);
  });

  // --- W1.7b, the self-diagnosis -----------------------------------------------------------

  it("forces both reads and asks six questions", async () => {
    const stub = renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));
    await screen.findByLabelText("Your code");
    const before = stub.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));

    await waitFor(() => expect(screen.getByRole("group", { name: /work out why/i })).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());
    const after = stub.calls.slice(before);
    expect(after.some((c) => c.method === "GET" && c.path === "/api/v1/me/door")).toBe(true);
    // D1: "the code" half of the check is an exchange with the club about the key.
    expect(after.some((c) => c.method === "GET" && c.path === "/api/v1/me/code")).toBe(true);
    expect(screen.getByRole("group", { name: /work out why/i }).querySelectorAll("li")).toHaveLength(6);
  });

  /**
   * The all-clear arm. It is the one that matters and the one that would be easiest to
   * omit, and it is never "no refusals found", never "nothing to show", never blank.
   */
  it("concludes that the problem is at the door when nothing on the phone is wrong", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:45:00Z"));
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));
    await advance(0);
    await codeOnScreen();

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await advance(0);
    await codeOnScreen();
    await advance(0);

    const panel = screen.getByRole("group", { name: /work out why/i });
    expect(panel).toHaveTextContent(/whatever went wrong is at the door/i);
    expect(panel).toHaveTextContent("021 555 0134");
    expect(panel.textContent).not.toMatch(/no refusal|nothing to show/i);
  });

  it("names the membership and nothing else when that is the first thing wrong", async () => {
    renderBoth(memberDoorNotActiveFixture("suspended", { policy: "booking_window", next_booking: BOOKING }));
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    expect(panel).toHaveTextContent(/only the club can change it/i);
    expect(panel.textContent).not.toMatch(/had run out/i);
  });

  /**
   * The checklist says WHICH not-active, exactly as the standing line does. A member who
   * reads "suspended" in the line and "not active" two centimetres below it is reading a
   * screen that has two answers to one question.
   */
  it.each([
    ["pending_approval", "not yet approved"],
    ["suspended", "suspended"],
    ["rejected", "turned down"],
  ] as const)("names %s on the checklist row and in its conclusion", async (detail, word) => {
    renderBoth(memberDoorNotActiveFixture(detail, { policy: "booking_window", next_booking: BOOKING }));
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    const row = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("Your membership"));
    expect(row?.textContent).toContain(word);
    expect(row?.textContent).toContain("Failed");
    expect(panel).toHaveTextContent(new RegExp(`membership as ${word}`));
  });

  /**
   * <b>Ruling 15 reversed this case, and the reversal is the point.</b>
   *
   * <p>
   * It used to assert that the row neither passed nor failed, because a member with no
   * membership row was not barred — `MembershipAccess.StatusIfBarredAsync` answered null and
   * `GateAccess` walked straight past the check, so the door opened for somebody the club had
   * no record of. That was a hole in the product, not a state of hers, and the backend closes
   * it: no membership row is now refused with its own reason.
   * </p>
   *
   * <p>
   * So the row fails, and the sentence still refuses to say "not active" — there is nothing to
   * reactivate, and sending her to the desk to argue about a suspension she does not have is
   * how a five-minute errand becomes an argument. It names who fixes it instead.
   * </p>
   */
  it("fails the membership row for a member the club has nothing on file for, without calling it inactive", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: BOOKING,
      membership: "none", membership_detail: "none",
    }));
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    const row = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("Your membership"));
    expect(row?.textContent).not.toContain("Passed");
    expect(row?.textContent).toContain("Failed");
    expect(row?.textContent).toContain("the club has to add you");
    // Never "not active": there is no membership to reinstate.
    expect(row?.textContent).not.toMatch(/not active|suspended/i);
  });

  /**
   * The checklist's window row reads the same instant the decision card counts down from,
   * and it has to: `too_early` is exactly the state in which `next_booking` is null, so a
   * row fed only by the booking would answer "no window to wait for" to the one member
   * who has a window and is waiting it out.
   */
  it("judges the door's window from the decision's own instant when there is no booking", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:03:00Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null,
      last_decision: memberDoorDecisionFixture({
        at: "2026-09-19T16:02:00Z", reason: "too_early", opens_at: "2026-09-19T16:30:00Z",
      }),
    }));
    await advance(0);

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await advance(0);

    const panel = screen.getByRole("group", { name: /work out why/i });
    const row = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("The door's window"));
    // D1 — the code on screen is the member's one code, bounded by no booking of its own, so
    // the row states the decision's instant for the member rather than a booking code's window.
    expect(row?.textContent).toContain("opens for you at 18:30");
    expect(row?.textContent).not.toContain("no window to wait for");

    // And the booking row must not fail either. `opens_at` is only ever computed BECAUSE
    // a qualifying booking was found; telling this member they have none, and sending
    // them to book another, is the checklist contradicting the countdown above it.
    const booking = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("Your booking"));
    expect(booking?.textContent).toContain("Passed");
    // E-H2 (2) — the conclusion LEADS with the club's own record of the refusal, which is
    // the one line on this control that is not an inference from what the phone can see.
    // It used to reason its way to "the window hasn't opened yet" while the club's record,
    // one request away, said so in the club's own words.
    expect(panel).toHaveTextContent(/club's own record/i);
    expect(panel).toHaveTextContent(/hadn't opened the door yet/i);
    expect(panel.textContent).not.toMatch(/Book one from the schedule/);
  });

  /**
   * And with nothing on the club's record, the same member gets the reasoned answer — which
   * is what makes the arm above an addition rather than a replacement.
   */
  it("reasons its way to the window when the club has no recent refusal recorded", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:03:00Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null,
      // An hour old: past the fifteen minutes the check will lead with, and the server
      // would not have sent it at all. The page must not reach back for it.
      last_decision: memberDoorDecisionFixture({
        at: "2026-09-19T15:02:00Z", reason: "too_early", opens_at: "2026-09-19T16:30:00Z",
      }),
      // A MEMBER code on screen, which has no window of its own — so the row and the
      // conclusion both fall back to what the club's decision said the window was.
    }), IDENT_CODE);
    await advance(0);

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await advance(0);

    const panel = screen.getByRole("group", { name: /work out why/i });
    expect(panel.textContent).not.toMatch(/club's own record/i);
    expect(panel).toHaveTextContent(/window hasn't opened yet/i);
    expect(panel).toHaveTextContent(/Everything else is fine/i);
  });

  /** The other half: genuinely nothing booked, and the row fails and says so. */
  it("fails the booking row when there is neither a booking nor a window to wait for", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null,
      last_decision: memberDoorDecisionFixture({ reason: "no_booking", opens_at: null }),
    }));
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    const booking = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("Your booking"));
    expect(booking?.textContent).toContain("Failed");
    expect(booking?.textContent).toContain("none starting soon");
    // E-H2 (2) — the club wrote down why, so that leads; the way to a court is still on
    // screen as a control, which is what the member actually needs to press.
    expect(panel).toHaveTextContent(/club's own record/i);
    expect(panel).toHaveTextContent(/no court booked that the door would open for/i);
    // Two of them on the page — the standing line's and the check's — and both are the
    // one thing this member needs to press.
    expect(screen.getAllByRole("link", { name: "Book a court" }).length).toBeGreaterThan(0);
  });

  /**
   * Colour is never the only signal: the failed row says "Failed" in words — and it is
   * only the phone's row to fail when the phone is genuinely what failed. See below.
   */
  it("marks the connection row as failed in words when the phone could not reach the club", async () => {
    stubFetch([
      ...memberCodeRoutes(),
      unreachable("/api/v1/me/door"),
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    const connection = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("This phone's line"));
    expect(connection?.textContent).toContain("Failed");
    // And the four rows only the club can answer say they were never asked, rather than
    // defaulting to fine above a row that has just failed. This stub has no cached copy.
    expect(panel).toHaveTextContent(/unanswered rather than fine/i);
    expect(panel).toHaveTextContent(/no answer from the club/);
    expect(panel).not.toHaveTextContent(/Your membership.*active.*Passed/);
  });

  /**
   * D2, on the assembled page. The club's API answered 500 — the phone carried the
   * request there and brought the answer back — and the screen scored the phone's own line
   * ✗ Failed and told the member their phone could not reach the club. Both false, and the
   * member spent the next minute looking for signal they already had.
   */
  it("does not fail the phone's row when it was the club's system that answered with an error", async () => {
    stubFetch([
      ...memberCodeRoutes(),
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    const connection = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("This phone's line"));
    expect(connection?.textContent).not.toContain("Failed");
    expect(connection?.textContent).toContain("Not what failed here");
    expect(panel).toHaveTextContent(/answered with an error/i);
    expect(panel).toHaveTextContent(/not your phone/i);
    expect(document.body.textContent).not.toMatch(/Your phone can't reach the club/);
  });

  // --- W1.7c, club contact ------------------------------------------------------------------

  it("keeps the club's number on the page whether or not anything was refused", async () => {
    renderBoth(memberDoorsOnFixture({ last_decision: null }));

    const tel = await screen.findByRole("link", { name: "021 555 0134" });
    expect(tel).toHaveAttribute("href", "tel:0215550134");
    // A 44px hit area, not sixteen-pixel text a cold thumb cannot find.
    expect(tel.className).toContain("min-h-11");
    expect(screen.getByRole("link", { name: "info@crusaders.co.za" }))
      .toHaveAttribute("href", "mailto:info@crusaders.co.za");
  });

  it("tells a member with no club contact where the only remaining answer is", async () => {
    renderBoth(memberDoorsOnFixture({
      contact: { phone: null, email: null },
      last_decision: memberDoorDecisionFixture({ reason: "member_not_active" }),
    }));

    await screen.findAllByText(/The club has your membership as not active\./);
    expect(screen.getAllByText(/Whatever is written on the door is the only way from here/).length)
      .toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /Call the club/ })).toBeNull();
  });

  // --- offline, which the service worker cannot serve -----------------------------------------

  // --- what the real endpoint sends, on the rendered page -------------------------------

  /**
   * The fixture against the endpoint's own key set.
   *
   * <p>
   * This page was built against a stub and the stub was narrower than the API. A fixture
   * that is narrower than the response is the mechanism by which that happens twice: every
   * assertion below it passes, and the field nobody stubbed is the field nobody renders.
   * The list is `MeDoorEndpoints.DoorAsync`'s anonymous type, key for key.
   * </p>
   */
  it("stubs every key GET /api/v1/me/door actually returns", () => {
    expect(Object.keys(memberDoorFixture()).sort()).toEqual([
      "contact", "door_log_retention_days", "doors", "doors_shut", "early_entry_minutes",
      "is_club_admin", "last_decision", "membership", "membership_detail", "next_booking",
      "policy", "roster_max_entries", "timezone",
    ]);
    expect(Object.keys(memberDoorBookingFixture()).sort()).toEqual([
      "court_number", "door_closes_at", "door_opens_at", "ends_at", "starts_at",
    ]);
    expect(Object.keys(memberDoorDecisionFixture()).sort()).toEqual([
      "at", "delivered_at", "door_name", "offline", "opens_at", "reason", "released",
    ]);
  });

  // --- WIRE-R1 §2 / §8: the two instants a door scan has -----------------------------------

  /**
   * `at` is when the code was held up; `delivered_at` is when the club heard. They differ
   * only for a door that had lost the network and decided alone — and that gap is the
   * answer to a question a member really does ask, which is why the club's own screens
   * showed nothing while they were being let in.
   */
  it("says when the club heard, on a decision a cut-off door made alone", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorOfflineDecisionFixture({ door_name: "front-door" }),
    }));

    // D6 appended the age. A member who pocketed the phone for ninety seconds cannot tell
    // a fresh card from a stale one off an absolute time alone.
    expect(await screen.findByText(/^front-door · \d{2}:\d{2} · the club heard at \d{2}:\d{2} · just now$/))
      .toBeInTheDocument();
  });

  /**
   * And says nothing of the sort for a row that never made that journey. A delivery time
   * on a scan the door asked the club about at the time is a delay that did not happen.
   */
  it("prints no delivery time for a decision the door asked the club about", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "no_booking" }),
    }));

    expect(await screen.findByText(/^front-door · \d{2}:\d{2} · just now$/)).toBeInTheDocument();
    expect(screen.queryByText(/the club heard at/)).toBeNull();
  });

  /**
   * §6.2 row 7. `GateAccess` lets a club admin past the BOOKING check under
   * `booking_window`, so the page was sending its own club's admins to book a court to
   * open a door that would have opened anyway.
   */
  it("tells a club admin under the booking rule that a door opens without a booking", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", is_club_admin: true, next_booking: null,
    }));

    const line = await screen.findByText(/You're a club admin/);
    expect(line).toHaveTextContent(/without one/);
    // P6's half, which is the whole point of saying it here rather than nowhere.
    expect(line).toHaveTextContent(/bookings, not admins/);
    expect(screen.queryByRole("link", { name: "Book a court" })).toBeNull();
  });

  /** The carve-out is the booking check only. A suspended admin is still refused. */
  it("does not offer the admin carve-out to an admin the club has suspended", async () => {
    renderBoth(memberDoorNotActiveFixture("suspended", {
      policy: "booking_window", is_club_admin: true, next_booking: null,
    }));

    expect(await screen.findByText(/as suspended/)).toBeInTheDocument();
    expect(screen.queryByText(/club admin/i)).toBeNull();
  });

  // --- membership_detail: which not-active this is -------------------------------------

  it.each([
    ["pending_approval", /not yet approved/],
    ["suspended", /as suspended/],
    ["rejected", /turned down/],
  ] as const)("says on the page which not-active %s is", async (detail, expected) => {
    renderBoth(memberDoorNotActiveFixture(detail, { policy: "active_member" }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
    // The old sentence, which said the same thing to all three, must be gone rather than
    // sitting beside the new one.
    expect(screen.queryByText(/as not active,/)).toBeNull();
  });

  /**
   * `membership: "none"` — a user with no membership row — and the page must not
   * contradict the door. `StatusIfBarredAsync` answers null for that member, so
   * `GateAccess` walks past the check and the door opens.
   */
  /**
   * R3-5 said this member must not be told her membership is "not active", and that still
   * holds — there is nothing to reactivate. Ruling 15 changed the second half: the door used
   * to open for her (`StatusIfBarredAsync` answered null and the check was skipped), and the
   * backend now refuses her with a reason of her own. So the sentence names the difference
   * from a membership the club has switched OFF, and states the refusal rather than denying
   * one — and it still never finishes on a promise.
   */
  it("tells a member with no membership row there is no record, not that theirs is off", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "active_member", membership: "none", membership_detail: "none",
    }));

    const line = await screen.findByText(/no membership on file for you/);
    expect(line).toHaveTextContent(/not the same as one it has turned off/);
    expect(line).toHaveTextContent(/no code of yours opens a door/);
    expect(line).not.toHaveTextContent(/A live member code of yours opens the club door/);
    // Neither neighbour's sentence: not "yours is active" and not "yours is not active".
    expect(line).not.toHaveTextContent(/Yours is active/);
    expect(screen.queryByText(/not active/i)).toBeNull();
  });

  // --- early_entry_minutes: the club's own number --------------------------------------

  it("names the club's own early-entry window when there is nothing booked", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null, early_entry_minutes: 45,
    }));

    expect(await screen.findByText(/nothing booked in the next 45 minutes/)).toBeInTheDocument();
  });

  it("says it wordlessly when the club has no early-entry window set", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null, early_entry_minutes: 0,
    }));

    expect(await screen.findByText(/nothing booked soon enough for a door to open/)).toBeInTheDocument();
    expect(screen.queryByText(/next 0 minutes/)).toBeNull();
  });

  it("names it on the no_booking refusal card too", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null, early_entry_minutes: 90,
      last_decision: memberDoorDecisionFixture({ reason: "no_booking" }),
    }));

    expect(await screen.findByText(/none starting in the next 1 hour 30 minutes/)).toBeInTheDocument();
  });

  // --- last_decision.opens_at: the countdown that could not fire -----------------------

  /**
   * The countdown the page could almost never draw.
   *
   * <p>
   * It used to come from `next_booking.door_opens_at`, and `too_early` means the booking's
   * window has NOT opened — which is exactly the condition under which `NextBookingAsync`
   * returns null. So the commonest too-early card on the product carried no countdown at
   * all. This fixture is that case: a refusal with `opens_at` on it and NO booking beside
   * it, which is what the endpoint really sends.
   * </p>
   */
  it("counts down from the decision's own instant when there is no booking to fall back to", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:03:00Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: null,
      last_decision: memberDoorDecisionFixture({
        at: "2026-09-19T16:02:00Z", reason: "too_early", opens_at: "2026-09-19T16:30:00Z",
      }),
    }));
    await advance(0);

    const card = screen.getByRole("status");
    expect(card).toHaveTextContent(/Too early — the door opens for you in 27m 00s\./);
    await advance(60_000);
    expect(card).toHaveTextContent(/26m 00s/);
  });

  /** The decision's instant outranks the booking's when both are there. */
  it("prefers the decision's instant over the booking's window", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:03:00Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: memberDoorBookingFixture({ door_opens_at: "2026-09-19T16:10:00Z" }),
      last_decision: memberDoorDecisionFixture({
        at: "2026-09-19T16:02:00Z", reason: "too_early", opens_at: "2026-09-19T16:30:00Z",
      }),
    }));
    await advance(0);

    const card = screen.getByRole("status");
    expect(card).toHaveTextContent(/opens for you in 27m 00s/);
    // The booking's own window would have given 7m — a countdown to the wrong instant,
    // which is a member watching a clock reach zero at a door that refuses them.
    expect(card).not.toHaveTextContent(/\b7m 00s/);
    expect(card).toHaveTextContent(/until 18:30/);
  });

  /**
   * Only `too_early` gets a clock, and the difference is a running interval rather than
   * anything on screen.
   *
   * <p>
   * The mutation pass found nothing holding this: every other arm ignores `ctx.countdown`,
   * so counting down on a `no_booking` card renders identically and costs a member a
   * re-render a second for as long as the card is open. Measured rather than reasoned
   * about — the two fixtures differ in one field, so the extra timer is the whole of the
   * difference between them.
   * </p>
   */
  it("starts no per-second clock on a refusal that is not a matter of waiting", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:03:00Z"));
    const opensAt = "2026-09-19T16:30:00Z";

    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null,
      last_decision: memberDoorDecisionFixture({ at: "2026-09-19T16:02:00Z", reason: "too_early", opens_at: opensAt }),
    }));
    await advance(0);
    const withClock = vi.getTimerCount();

    cleanup();
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null,
      last_decision: memberDoorDecisionFixture({ at: "2026-09-19T16:02:00Z", reason: "no_booking", opens_at: opensAt }),
    }));
    await advance(0);

    expect(vi.getTimerCount()).toBe(withClock - 1);
  });

  // --- last_decision.offline: the other half of the open -------------------------------

  /**
   * §6.1's second `ok` arm, and P6. A door that had lost the club's network matched the
   * code against a list it downloaded earlier; the club's record of it arrived afterwards.
   * A member told only "the lock released" has not been told either fact.
   */
  it("distinguishes an open the door decided alone from one the club answered", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "ok", released: true, offline: true }),
    }));

    const card = await screen.findByRole("status");
    expect(card).toHaveTextContent(/from the door's own list/);
    expect(card).toHaveTextContent(/couldn't reach the club/);
    expect(card).toHaveTextContent(/arrived afterwards/);
    // A1.2 holds on this arm exactly as it does on the other.
    expect(card).not.toHaveTextContent(/door opened|let you in|walked in/);
  });

  it("says the shorter sentence for an open the club was reachable for", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "ok", released: true, offline: false }),
    }));

    const card = await screen.findByRole("status");
    expect(card).toHaveTextContent(/The lock released\./);
    expect(card).not.toHaveTextContent(/own list/);
  });

  // --- roster_max_entries: the club's own cap ------------------------------------------

  it("takes the offline roster cap from the response rather than from its own constant", async () => {
    renderBoth(memberDoorsOnFixture({ roster_max_entries: 12 }));

    await screen.findByText(/What if the door is offline/);
    expect(screen.getByText(/next 12 bookings due to start/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`first ${GATE_ROSTER_MAX_ENTRIES} bookings`))).toBeNull();
  });

  // --- D4: the boundaries the page already knows about ---------------------------------

  /**
   * An open page kept a finished booking's code, in the present tense, with a healthy
   * countdown under it, twenty minutes after the court had ended.
   *
   * <p>
   * Nothing was broken. Everything on that screen was true when it was fetched, and the
   * only thing standing between the member and a wrong answer was how often the page
   * happened to ask again — a booking code lives forty-five minutes, so the switch fired
   * when the code died rather than when the booking did. A poll rate is not an argument.
   * The booking's end is a field the page is already rendering.
   * </p>
   */
  it("re-reads when the booking it is showing a code for ends", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T17:40:00Z"));
    const stub = stubFetch([
      ...memberCodeRoutes(),
      { path: "/api/v1/me/door", body: memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) },
    ]);
    renderPage(<MyCodePage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // The CODE fetch, not the door read. `useMemberDoor` polls on its own every thirty
    // seconds, so a count of door reads grows across any five-minute advance whatever this
    // hook does — a mutation pass proved exactly that, by deleting the booking's end from
    // the boundary list and watching this test stay green. A code fetch is paced and
    // nothing else is due: at 17:40 the code on screen has fifteen minutes left, so the
    // pre-fetch cannot fire, and the only thing that can ask for another is a boundary.
    // D1: a boundary also asks the club about the key (`GET /me/code`) — the one request
    // nothing else makes inside five minutes, which is what makes it countable.
    const codes = () => stub.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/me/code").length;
    const before = codes();
    // BOOKING ends at 17:45, and it is the only boundary inside this window: both edges of
    // the door window are 16:30 and 18:05.
    await advance(5 * 60_000 + 1_000);

    expect(codes()).toBeGreaterThan(before);
  });

  /**
   * The same rule from the other side: a door window that OPENS is a boundary too, and
   * the member watching a too-early countdown run to zero is the most attentive reader
   * this page ever has.
   */
  it("re-reads the moment a door window it is counting down to opens", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:25:00Z"));
    const stub = stubFetch([
      // The code carries NO door window of its own. Both reads send these instants, and a
      // fixture where they agree cannot tell which of the two the page is actually
      // watching: a mutation pass deleted the door read's `door_opens_at` from the
      // boundary list and this test stayed green on the code's copy of the same minute.
      ...memberCodeRoutes(),
      { path: "/api/v1/me/door", body: memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) },
    ]);
    renderPage(<MyCodePage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Counted on the code fetch for the reason the test above carries in full.
    const codes = () => stub.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/me/code").length;
    const before = codes();
    // BOOKING's door_opens_at is 16:30, and it is the only boundary inside this window:
    // the booking ends at 17:45 and its window closes at 18:05.
    await advance(5 * 60_000 + 1_000);
    expect(codes()).toBeGreaterThan(before);
  });

  // --- D5: an expired code is replaced, never dimmed ------------------------------------


  // --- D9: the door section says a question is being asked -------------------------------

  /**
   * `/me/door` took four seconds and more, and for all of it the page rendered the
   * court-only copy with total confidence and no door section at all — then grew one
   * under the member's thumb.
   */
  it("says it is still finding out, rather than rendering the court-only page confidently", async () => {
    stubFetch([
      ...memberCodeRoutes(),
    ]);
    // A read still IN FLIGHT, which is the state the harness has no shape for: a route it
    // does not know rejects, and a rejection is a read that failed. The finding is about
    // the four seconds before either answer — so the door route hangs, and nothing else
    // about the stub changes.
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => (
      String(input).startsWith("/api/v1/me/door")
        ? new Promise<Response>(() => {})
        : (stubbed as typeof fetch)(input, init)
    )));
    renderPage(<MyCodePage />);

    expect(await screen.findByText(/Checking whether this club's doors/)).toBeInTheDocument();
    // And it is not the court-only page rendered with complete confidence.
    expect(screen.queryByText(/The door didn't open/)).toBeNull();
  });

  it("stops saying it once the club has answered that it has no door", async () => {
    renderBoth(memberDoorFixture(), { ...CODE, doors: false, door_opens_at: null, door_closes_at: null });
    await screen.findByLabelText("Your code");

    await waitFor(() => expect(screen.queryByText(/Checking whether this club's doors/)).toBeNull());
    // And the club with no door still meets the word nowhere.
    expect(screen.queryByText(/door/i)).toBeNull();
  });

  // --- item 9: the capsule tabs, remembered and offered ------------------------------------





  // --- D14: the member's own record, one tap away ------------------------------------------

  it("links to the member's own door history from the code page", async () => {
    renderBoth(memberDoorsOnFixture());
    await screen.findByLabelText("Your code");

    const link = screen.getByRole("link", { name: "Your door history" });
    expect(link).toHaveAttribute("href", "/profile#door-history");
  });

  it("offers no such link at a club with no door", async () => {
    renderBoth(memberDoorFixture(), { ...CODE, doors: false, door_opens_at: null, door_closes_at: null });
    await screen.findByLabelText("Your code");

    expect(screen.queryByRole("link", { name: "Your door history" })).toBeNull();
  });

  // --- D1, on the assembled page ------------------------------------------------------------

  /**
   * The screenshot that opened the finding: a `/me/door` that never landed, and a page
   * telling a member standing outside a locked building that their club has given the app
   * no number — then telling them to fix it under Admin settings.
   */
  it("never says the club has no number off a read it could not make", async () => {
    stubFetch([
      ...memberCodeRoutes(),
      unreachable("/api/v1/me/door"),
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    await waitFor(() => expect(screen.getByText(/Couldn't load the club's number/)).toBeInTheDocument());
    expect(screen.queryByText(/hasn't given the app a number/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Admin settings/i);
  });

  it("says the same off a club system that answered with an error", async () => {
    stubFetch([
      ...memberCodeRoutes(),
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    await waitFor(() => expect(screen.getByText(/Couldn't load the club's number/)).toBeInTheDocument());
    expect(screen.queryByText(/hasn't given the app a number/)).toBeNull();
  });

  it("still offers a last-known number, with its age, rather than nothing", async () => {
    rememberDoor(memberDoorsOnFixture({ contact: { phone: "021 555 0134", email: null } }) as never);
    stubFetch([
      ...memberCodeRoutes(),
      unreachable("/api/v1/me/door"),
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    await waitFor(() => expect(screen.getByRole("link", { name: "021 555 0134" })).toBeInTheDocument());
    expect(screen.getByText(/This is the number it gave/)).toBeInTheDocument();
  });

  // --- D6: the code itself, at a root font this page did not survive --------------------------

  /**
   * Nothing between the glass and the symbol is measured in the reader's own font size.
   *
   * <p>
   * <b>The property, not the class string.</b> The first version of this assertion named
   * the exact arbitrary value the fix had used — and that value was itself wrong: it
   * subtracted the page gutter as it measures at the DEFAULT root, so at a 32px root the
   * symbol wanted more width than the card had and dragged the page column off the glass.
   * A test pinned to the literal would have stayed green through every step of that, because
   * the string it was asserting never changed. What makes the symbol root-invariant is that
   * every length in the chain — the card's width, the card's padding, the cap on the symbol
   * — is a pixel or a viewport unit, and that is what is checked.
   * </p>
   *
   * <p>
   * jsdom computes no layout, so the sizes themselves are measured in `e2e/my-code.spec.ts`
   * at two viewports and two root fonts. This holds the rule those measurements come from.
   * </p>
   */
  function expectRootInvariantCode(qr: HTMLElement) {
    // D1: the symbol sits on the pass card. Every element between the card's edge and the
    // symbol is in the width chain — the card, the pass body, the white panel, the button.
    const card = qr.closest("[data-pass-card]") as HTMLElement;
    const body = qr.closest("[data-pass-body]") as HTMLElement;
    const panel = qr.closest("[data-qr-panel]") as HTMLElement;
    const button = qr.closest("button") as HTMLElement;
    const chain = [card, body, panel, button, qr].map((el) => el.getAttribute("class") ?? "").join(" ");
    // A rem anywhere in the width chain is the defect, in any spelling: `max-w-xs`, a `px-5`
    // on the body, or a `20rem` inside an arbitrary value.
    expect(chain).not.toMatch(/rem/);
    expect(chain).not.toMatch(/\b(max-)?w-(xs|sm|md|lg|xl)\b/);
    expect(chain).not.toMatch(/\bp[xy]?-\d/);
    // The symbol fills what the panel has; the panel is capped in pixels; the card is pinned
    // to the viewport in pixels.
    expect(qr.getAttribute("class")).toContain("w-full");
    expect(button.className).toContain("w-full");
    expect(panel.className).toMatch(/max-w-\[\d+px\]/);
    expect(body.className).toMatch(/px-\[\d+px\]/);
    expect(card.className).toMatch(/w-\[min\(calc\(100vw-\d+px\),\d+px\)\]/);
  }


  /**
   * `max-w-xs` is 20 REM, and a rem is whatever the reader has set. At a root font of 32px
   * it resolved to 640px inside a 360px phone: the symbol ran off both edges, the
   * twelve-character fallback ran off with it, and the whole page scrolled sideways. A
   * jsdom test cannot see the overflow — the Playwright one below can — but it CAN hold
   * the rule that caused it, which is what a regression would change.
   */
  it("caps the code and the QR against the column, not against the root font", async () => {
    renderBoth(memberDoorsOnFixture());
    const code = await screen.findByLabelText("Your code");

    // The grouped code wraps between groups rather than running off the glass — balanced
    // (F4-16), with a break opportunity between every two groups.
    const groups = code.querySelector(":scope > span")!;
    expect(groups.className).toContain("text-balance");
    expect(groups.querySelectorAll("wbr")).toHaveLength(groups.querySelectorAll("[data-code-group]").length - 1);
    expectRootInvariantCode(screen.getByRole("img", { name: /QR code/ }));
  });


  // --- D1: the door section does not belong to the code read -------------------------
  //
  // Each read failing ALONE was handled well, and the two failing together deleted the
  // whole subject: no door section, no self-check, no link to the member's own record, and
  // not one tel: or mailto: anywhere on the screen — for the member standing at the door in
  // the dark, who is the entire reason this surface exists. So the matrix is swept rather
  // than sampled: two reads, each failing or landing, times a last-known store that is
  // there or is not.

  /** Every combination of the two reads, with and without something cached. */
  const READ_COMBINATIONS = [
    ["both reads land", false, false],
    ["the code read fails", true, false],
    ["the door read fails", false, true],
    ["both reads fail", true, true],
  ] as const;

  function seedCache() {
    rememberDoor(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) as never);
  }

  it.each(READ_COMBINATIONS.flatMap(([name, codeFails, doorFails]) =>
    [true, false].map((cached) => [`${name}, ${cached ? "with" : "without"} a cached copy`, codeFails, doorFails, cached] as const)))(
    "keeps the door section, the self-check, the history link and a way to a human when %s",
    async (_name, codeFails, doorFails, cached) => {
      if (cached) seedCache();
      stubFetch([
        ...memberCodeRoutes(codeFails ? { enrol: unreachable("/api/v1/me/code/enrol", "POST") } : {}),
        doorFails
          ? unreachable("/api/v1/me/door")
          : { path: "/api/v1/me/door", body: memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) },
        { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
      ]);
      renderPage(<MyCodePage />);

      // The door section exists in every one of the eight, whatever it can say in it.
      await screen.findByRole("heading", { name: /What opens the door for you right now/ });
      // The self-check exists, because "the door didn't open" is the question this page is
      // for and no read failing makes it stop being asked.
      expect(screen.getByRole("button", { name: "The door didn't open" })).toBeInTheDocument();
      // The member's own record is one tap away.
      expect(screen.getByRole("link", { name: "Your door history" })).toBeInTheDocument();
      // And a way to a human: either a real link, or an honest admission that the page
      // could not find one — never silence, and never a false negative about the club.
      const reachable = screen.queryAllByRole("link").some((a) => /^(tel|mailto):/.test(a.getAttribute("href") ?? ""));
      const admitted = !!document.body.textContent?.match(/couldn't load the club's number|couldn't reach the club/i);
      expect(reachable || admitted).toBe(true);
    },
  );

  /**
   * And the shape of the one that used to be silent: both reads failed and nothing was ever
   * cached, so the page had never been told this club HAS a door. It must not conclude that
   * it has none — that is an answer, and the page does not have one.
   */
  it("says it could not find out, rather than that the club has no door, when it never heard either read", async () => {
    stubFetch([
      ...memberCodeRoutes({ enrol: unreachable("/api/v1/me/code/enrol", "POST") }),
      unreachable("/api/v1/me/door"),
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);

    expect(await screen.findByText(/can't tell you what its doors need from you/i))
      .toHaveTextContent(/or whether this club has any/i);
    // It does not invent a club with no door, and it does not invent one with doors either.
    expect(screen.queryByText(/opens the club door/)).toBeNull();
  });

  /** A club that has genuinely ANSWERED that it has no door stays silent, as it always has. */
  it("still says nothing at all once the club has answered that it has no door", async () => {
    stubFetch([
      ...memberCodeRoutes({ enrol: unreachable("/api/v1/me/code/enrol", "POST") }),
      { path: "/api/v1/me/door", body: memberDoorFixture() },
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);

    // R15 X15-3 — onLine is true here: the club is unreachable, not the phone offline.
    await screen.findByRole("heading", { name: MY_CODE.needsClub.title });
    expect(screen.queryByRole("heading", { name: /What opens the door for you right now/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Your door history" })).toBeNull();
  });

  // --- D6: a fact from earlier carries its age --------------------------------------

  /**
   * `useMemberDoor` keeps the last good answer when a later read fails, which is right —
   * throwing away a true answer because the next request did not land leaves the member
   * with less. What was wrong is that it went on being rendered in the present tense, with
   * nothing to say it was from ten minutes ago, beside a code card saying "Run out".
   */
  it("says nothing about the age of door facts it can still re-read", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "active_member" }));

    const heading = await screen.findByRole("heading", { name: /What opens the door for you right now/ });
    expect(heading.textContent).not.toMatch(/may have changed/);
  });

  it("marks the door facts as from earlier once it can no longer re-read them", async () => {
    let doorReads = 0;
    stubFetch([
      ...memberCodeRoutes(),
      {
        path: "/api/v1/me/door",
        respond: () => {
          doorReads += 1;
          // The FIRST read lands, so the page holds a true answer; every one after it
          // fails, which is the state `useMemberDoor` deliberately keeps that answer
          // through — and the state in which it used to go on being rendered in the
          // present tense with nothing to say how old it was.
          if (doorReads > 1) throw new TypeError("Failed to fetch");
          return memberDoorsOnFixture({ policy: "active_member" });
        },
      },
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);

    await screen.findByRole("heading", { name: /What opens the door for you right now/ });
    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(doorReads).toBeGreaterThan(1));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /What opens the door for you right now/ }).textContent)
        .toMatch(/as of \d{2}:\d{2} — may have changed/));
    // And the sentence itself is still the club's own answer, not an apology in its place.
    expect(screen.getByText(/Your club opens its doors for any active member/)).toBeInTheDocument();
  });

  /**
   * D6, amending A3.2. The card stays until it is superseded or dismissed — a card that
   * vanishes mid-sentence while a cold member is reading it is the defect that rule exists
   * for. What A3.2 did not say is that it then stayed at full size and full confidence for
   * as long as the page was open: a green "The lock released · 10:02" was still the largest
   * thing on the screen twenty minutes later, over a code that had since run out.
   */
  it("ages the decision card and collapses it to one line, still dismissible", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorOfflineDecisionFixture({
        at: new Date(Date.now() - 12 * 60_000).toISOString(),
        delivered_at: new Date(Date.now() - 11 * 60_000).toISOString(),
      }),
    }));

    expect(await screen.findByText(/12 minutes ago/)).toBeInTheDocument();
    // Collapsed: the body of the card is gone, the headline and the stamp are not. The
    // fixture is the OFFLINE open, so the body to look for is that arm's — a negative
    // assertion aimed at the online arm's sentence passes whether or not anything
    // collapsed, which is how this one first went green against a mutation.
    expect(screen.getByText(/The lock released/)).toBeInTheDocument();
    expect(screen.queryByText(/decided from the list of/)).toBeNull();
    // One line: the headline and its stamp, and nothing else.
    expect(screen.queryByText(/Nothing about your booking changed/)).toBeNull();
    // And it can still be got rid of. A collapsed card a member cannot dismiss is worse
    // than a big one they can.
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("keeps a fresh decision at full size, with its body and its age", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ released: true, reason: "ok" }),
    }));

    expect(await screen.findByText(/There is no sensor on a door here/)).toBeInTheDocument();
    expect(screen.getByText(/just now/)).toBeInTheDocument();
  });

  // --- D8 / D10: the code is first, and nothing that comes and goes may move it --------

  /**
   * <b>D8.</b> The page opened with a heading, a two-line subtitle and a decision card, so
   * at 320×568 the QR was entirely below the fold: a member at a scanner had to scroll to
   * find the one thing they opened the page for. jsdom has no layout, so what is held here
   * is DOCUMENT ORDER — the QR before every explanation — and the Playwright spec measures
   * the fold itself.
   *
   * <p>
   * <b>D10</b> is the same edit from the other side: a decision arriving moved the QR down
   * 290 px on a screen somebody was holding against a scanner, and dismissing it moved the
   * QR back up. Below the code it cannot.
   * </p>
   */
  it("puts the code before every explanation of it, with or without a decision", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ released: true, reason: "ok" }),
    }));

    await screen.findByText(/The lock released/);
    // The QR is drawn from the code once the phone has made it — its own async step, not the
    // door read the line above waits for.
    const qrImage = await screen.findByRole("img", { name: /QR code/ });
    const order = (node: Element | null) => [...document.querySelectorAll("*")].indexOf(node!);
    const qr = order(qrImage);
    expect(qr).toBeLessThan(order(screen.getByText(/The lock released/)));
    expect(qr).toBeLessThan(order(screen.getByText(/Show this at the club door/)));
    expect(qr).toBeLessThan(order(screen.getByRole("heading", { name: /What opens the door/ })));
    // D1: there is no choice of code to put above it — the heading is the only thing that is.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(order(screen.getByRole("heading", { level: 1, name: "My Code" }))).toBeLessThan(qr);
  });

  // --- D12: the full-screen overlay --------------------------------------------------



  // --- C9 / D14: the dialog honours what it claims -----------------------------------

  /**
   * `aria-modal="true"` was a claim this overlay did not honour: Tab walked straight out of
   * it and through the page underneath — the header, the tab strip, every link on the code
   * page — while a screen reader went on announcing a dialog. For a keyboard or
   * screen-reader user that is worse than no dialog semantics at all, because the promise is
   * what stops them looking for the way out.
   */
  it("inerts the page behind the full-screen code and locks the background scroll", async () => {
    renderBoth(memberDoorsOnFixture());
    fireEvent.click(await screen.findByRole("button", { name: "Show your code full screen" }));
    await screen.findByRole("dialog", { name: /full screen/i });

    // Every sibling of the overlay, so the guard does not depend on an id that exists in
    // index.html and in no test harness.
    const behind = [...document.body.children].filter((n) => n.getAttribute("role") !== "dialog");
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.every((n) => n.hasAttribute("inert"))).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Restored to what it was, not to a default: another overlay may own them, and
    // clearing somebody else's lock is how a page ends up permanently unscrollable.
    expect([...document.body.children].some((n) => n.hasAttribute("inert"))).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps Tab inside the full-screen code", async () => {
    renderBoth(memberDoorsOnFixture());
    fireEvent.click(await screen.findByRole("button", { name: "Show your code full screen" }));
    const dialog = await screen.findByRole("dialog", { name: /full screen/i });
    const done = within(dialog).getByRole("button", { name: "Done" });

    // From the dialog itself, forward, to its only stop.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(done);
    // And from the last stop, forward, back round to the first rather than out to the page.
    done.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  // --- C17 and the LOW list ------------------------------------------------------------


  /** The hint that explains the page's one gesture, at 14px rather than 12. */
  it("sets the fill-the-screen hint at 14px", async () => {
    renderBoth(memberDoorsOnFixture());
    const hint = await screen.findByText(/Tap the code to fill the screen/);
    expect(hint.className).toContain("text-sm");
    expect(hint.className).not.toContain("text-xs");
  });
});


/**
 * Round 3's member findings, on the page rather than in the copy module.
 *
 * <p>
 * Each of these is a sentence or a control that was defensible in isolation and wrong
 * beside what the page drew next to it. The copy module's own table holds the sentences
 * against each other; this holds the PAGE against what it renders — which is where a dead
 * code sitting above a promise, two retry buttons for one failure, and focus landing on
 * `<body>` actually live.
 * </p>
 */
describe("MyCode — round 3", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); forgetLastKnown(); signOut(); cleanup(); });

  const CODE = {
    code: "7K3M9XQ2RD5A", kind: "booking", expires_in_seconds: 900, court_number: 3,
    starts_at: "2026-09-19T17:00:00Z", doors: true,
    door_opens_at: "2026-09-19T16:30:00Z", door_closes_at: "2026-09-19T18:05:00Z",
  };
  const EMPTY_HISTORY = { items: [], next_cursor: null, retention_days: 90, timezone: "Africa/Johannesburg" };

  /**
   * `_code` is the legacy code a call site used to hand the generate route. D1: there is one
   * code, enrolled from `memberCodeRoutes`, so the argument is accepted and ignored — every
   * call that passed a booking or an ident code now renders the single code.
   */
  function renderBoth(door: Record<string, unknown>, _code?: unknown) {
    const stub = stubFetch([
      ...memberCodeRoutes(),
      { path: "/api/v1/me/door", body: door },
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);
    return stub;
  }

  // --- R3-4: a field that never arrived is not a club that has shut something ----------

  /**
   * <b>It was on every account's screen in the round-3 evidence.</b> The review stack's API
   * predated WIRE-R2 §4 and sent no `doors_shut` at all, so every sentence built from it
   * compared `undefined` against `"none"`, failed, and fell through to the "some" arm —
   * while the arm that picks the promise fell through the other way and said a live member
   * code opens the club door. One missing field, two sentences, arguing with each other.
   */
  it("says nothing about shut doors when the response carried no doors_shut", async () => {
    const door = memberDoorsOnFixture({ policy: "active_member" }) as Record<string, unknown>;
    delete door.doors_shut;
    renderBoth(door, { ...CODE, kind: "ident", court_number: null, starts_at: undefined,
      door_opens_at: null, door_closes_at: null });

    await screen.findByText(/What opens the door for you right now/);
    expect(screen.queryByText(/has shut/)).toBeNull();
    // And with the field unread, no promise either — the page does not know what it would
    // be promising about.
    expect(screen.queryByText(/A live member code of yours opens the club door/)).toBeNull();
  });

  /** WIRE-R3 §5: when the club says which doors, the member is told which. */
  it("names the doors the club has shut", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "active_member", doors_shut: "some", doors_shut_names: ["Front door", "Side door"],
    }));

    expect(await screen.findByText(/Front door, and Side door|Front door and Side door/)).toBeInTheDocument();
  });

  // --- R3-7: one window, from the payload ---------------------------------------------



  // --- R3-8: sixty seconds without signal --------------------------------------------




  /** And never a code from the store that has itself run out. A hopeful QR in the dark. */

  // --- R3-10: Escape from the full-screen code ----------------------------------------

  /**
   * <b>Escape, Done and the hardware back button all left focus on `<body>`.</b> For a
   * keyboard user that is the top of the document — the next Tab starts from the skip link,
   * so closing the code threw away their place on the page. Focus belongs on the control
   * that opened the overlay.
   */
  it("gives focus back to the code when the full-screen view closes", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "active_member" }));

    const trigger = await screen.findByRole("button", { name: "Show your code full screen" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: /full screen/i });
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Show your code full screen" })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  // --- R3-29: the most urgent thing was below the fold --------------------------------

  /**
   * <b>Measured at 390×844: the decision card's top edge at y=829 against a 734px
   * scrollport.</b> The club's own answer to "why didn't the door open", ninety-five pixels
   * below the fold, on the screen of somebody standing at the door.
   *
   * <p>
   * It is PINNED rather than moved, because moving it back above the code re-opens D10 — a
   * decision arriving pushed the QR down 290px on a screen held against a scanner. The card
   * stays where it is; one line of it sits on the glass until the member has seen it.
   * </p>
   *
   * <p>
   * The observer is stubbed rather than polyfilled: what is being tested is what the page
   * does with the answer, and jsdom lays nothing out, so a real observer here would report
   * every element as invisible and prove nothing.
   * </p>
   */
  function stubIntersection(): (visible: boolean) => void {
    let fire: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    class Stub {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { fire = cb; }
      observe() { /* the test drives it */ }
      disconnect() { /* nothing held */ }
    }
    vi.stubGlobal("IntersectionObserver", Stub);
    return (visible: boolean) => act(() => { fire?.([{ isIntersecting: visible }]); });
  }

  it("pins one line of the decision while the card itself is out of sight", async () => {
    const intersect = stubIntersection();
    renderBoth(memberDoorsOnFixture({
      policy: "active_member",
      last_decision: memberDoorDecisionFixture({ released: true, reason: "ok" }),
    }));

    await screen.findByText(/That is what the door's board reported doing/);
    // Nothing pinned while the card is on screen — a second copy of a sentence the member
    // is already reading is noise.
    intersect(true);
    expect(screen.queryByTestId("decision-peek")).toBeNull();

    intersect(false);
    const peek = screen.getByTestId("decision-peek");
    expect(peek).toHaveTextContent("The lock released.");
    // The card carries `role="status"`; a second announcement of the same sentence is the
    // defect R3-26 names on the admin side. So the pin is out of the accessibility tree and
    // out of the tab order, and is a visual affordance only.
    expect(peek).toHaveAttribute("aria-hidden", "true");
    expect(peek.querySelector("button")).toHaveAttribute("tabindex", "-1");
    expect(peek.closest("[role=status]")).toBeNull();
  });

  /** And the page makes room for it, so the club's number is not underneath it. */
  it("leaves room at the foot of the page for the pinned line", async () => {
    stubIntersection();
    renderBoth(memberDoorsOnFixture({
      policy: "active_member",
      last_decision: memberDoorDecisionFixture({ released: true, reason: "ok" }),
    }));

    await screen.findByText(/That is what the door's board reported doing/);
    const heading = screen.getByRole("heading", { name: "My Code" });
    expect(heading.closest("[data-page-shell]")!.className).toMatch(/pb-24/);
  });

  // --- R3-30 / item 9: one control, one lifetime ----------------------------------------


});
