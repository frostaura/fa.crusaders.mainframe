import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * The doors surface, against a real build.
 *
 * <p>
 * <b>What a browser proves here that jsdom cannot.</b> Three things, and all three are why
 * this file exists rather than only the vitest suite. The ages TICK, so the honesty signal
 * P1 turns on is a real timer in a real event loop rather than a mocked one. The layout is
 * real, so a 64-character door name and a fifty-row feed can be measured against a 412 px
 * phone rather than inspected for a class name. And the confirms are two-step controls whose
 * armed labels ARE the copy, rendered by the same primitive the rest of the product uses.
 * </p>
 *
 * <p>
 * Several of these specs arrived from `admin-devices.spec.ts` with the controls they exercise
 * (A2.5): naming a door, clearing its name against a server that applies the API's own rule,
 * and the shut consequence. None was dropped in the move.
 * </p>
 */

const DOOR_ID = "99999999-9999-9999-9999-999999999999";
const OTHER_ID = "99999999-9999-9999-9999-99999999aaaa";

const SETTINGS = {
  slice_minutes: 15,
  slice_price_credits: 8,
  advance_booking_days: 14,
  day_start_minute: 360,
  day_end_minute: 1320,
  penalty_pct: 30,
  grace_window_minutes: 5,
  penalty_window_minutes: 15,
  timezone: "Africa/Johannesburg",
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00" },
  credits_per_zar_regular: 1.6,
  credits_per_zar_league: 2.4,
  topup_block_zar: 100,
  topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60,
  peak_hours: "16:00-19:00",
  peak_advance_hours_for_regular: 1,
  retention_years: 2,
  no_show_lookback_days: 7,
  walk_up_max_minutes: 90,
  heartbeat_seconds: 60,
  activation_forward_window_minutes: 120,
  activation_cue_window_minutes: 10,
  qr_lifetime_seconds: 60,
  roster_window_minutes: 120,
  device_alert_cooldown_minutes: 60,
  gate_unlock_seconds: 3,
  gate_access_policy: "active_member",
  gate_early_entry_minutes: 30,
  door_log_retention_days: 90,
  door_refusal_spike_count: 8,
  door_refusal_spike_minutes: 20,
  club_contact_phone: "076 226 1390",
  club_contact_email: "squash@example.co.za",
};

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

function door(overrides: Record<string, unknown> = {}) {
  return {
    id: DOOR_ID,
    device_code: "gate-0a1b2c",
    name: "Side door",
    kind: "Gate",
    hardware: "Esp32",
    court_numbers: [],
    gate_key: "side-door",
    mac_address: "5ccf7f0a1b2c",
    enabled: true,
    last_seen_at: ago(12),
    last_ip_address: "192.168.68.160",
    running_version: "1.0.0",
    mega_version: null,
    created_at: new Date().toISOString(),
    auto_registered: false,
    effective_heartbeat_seconds: 60,
    location_note: null,
    power_loss_behaviour: "not_established",
    out_of_service_since: null,
    ...overrides,
  };
}

type DoorsOptions = {
  today?: Record<string, { released: number; refused: number } | null>;
  signals?: Record<string, { kind: string; since: string; until: string; scans: number }[]>;
};

function doorsView(doors: Record<string, unknown>[], options: DoorsOptions = {}) {
  return {
    day_started_at: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
    timezone: "Africa/Johannesburg",
    // C1 / WIRE-R1 §4: a shut-all is standing only when a shut-all shut something. This
    // used to be `doors.some(d => !d.enabled)`, which made a door shut on its OWN look like
    // a fleet shut — the exact conflation that produced "Reopen all 3" over a request that
    // reopened none of them, and the reason no browser test could see the bug.
    shut_all_active: doors.some((d) => d.enabled === false && d.shut_by_shut_all_at != null),
    // NAMED, not counted. The fleet control reads its label and its confirm off these.
    shut_together: doors
      .filter((d) => d.enabled === false && d.shut_by_shut_all_at != null)
      .map((d) => ({ id: d.id, name: d.name, gate_key: d.gate_key })),
    shut_individually: doors
      .filter((d) => d.enabled === false && d.shut_by_shut_all_at == null)
      .map((d) => ({ id: d.id, name: d.name, gate_key: d.gate_key })),
    doors: doors.map((device) => ({
      device,
      today: options.today && String(device.id) in options.today
        ? options.today[String(device.id)]
        : { released: 4, refused: 1 },
      signals: options.signals?.[String(device.id)] ?? [],
    })),
  };
}

function routes(doors: Record<string, unknown>[], extra: ApiRoute[] = [], options: DoorsOptions = {}): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001", member_class: "Regular" } },
    { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], count: 0 } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    { path: `/api/v1/admin/devices/${DOOR_ID}/activity`, body: { items: [], events: [] } },
    { path: "/api/v1/admin/doors/activity", body: { items: [], next_cursor: null, retention_days: 90 } },
    { path: "/api/v1/admin/doors", body: doorsView(doors, options) },
    ...extra,
  ];
}

async function openDoors(page: Page, doors: Record<string, unknown>[], extra: ApiRoute[] = [], options: DoorsOptions = {}) {
  await signIn(page);
  await serveApi(page, routes(doors, extra, options));
  await page.goto("/admin/doors");
  await expect(page.getByRole("heading", { name: "Doors", level: 1 })).toBeVisible();
}

async function openDoor(page: Page, doors: Record<string, unknown>[], extra: ApiRoute[] = [], options: DoorsOptions = {}) {
  await signIn(page);
  await serveApi(page, routes(doors, extra, options));
  await page.goto(`/admin/doors/${DOOR_ID}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test.describe("The doors overview", () => {
  /**
   * <b>The age ticks, in a real event loop.</b> P1 makes the live age the load-bearing
   * honesty signal — a scan is a pull, and no control may look instant when it is not — and
   * a mocked timer proves nothing about whether the page actually moves.
   */
  test("ticks each door's age without going back to the server", async ({ page }) => {
    await openDoors(page, [door({ last_seen_at: ago(12) })]);

    const age = page.getByText(/Heard from \d+s ago/);
    await expect(age).toBeVisible();
    const first = await age.textContent();

    let reads = 0;
    await page.route("**/api/v1/admin/doors**", async (route) => { reads += 1; await route.fallback(); });
    await page.waitForTimeout(2500);

    await expect(age).not.toHaveText(first ?? "");
    expect(reads).toBe(0);
  });

  test("says Reporting, and no chip anywhere says Working", async ({ page }) => {
    await openDoors(page, [door()]);

    await expect(page.getByText("Reporting")).toBeVisible();
    const tile = page.getByRole("article", { name: "Side door" });
    await expect(tile).not.toContainText("Working");
    await expect(tile).not.toContainText("Online");
  });

  test("carries two chips for a reporting door with no name", async ({ page }) => {
    await openDoors(page, [door({ gate_key: null })]);

    await expect(page.getByText("Reporting")).toBeVisible();
    await expect(page.getByText("Needs a door name")).toBeVisible();
    await expect(page.getByText(/opens nothing at all while it is offline/)).toBeVisible();
  });

  test("renders two scan numbers under a named club-time boundary", async ({ page }) => {
    await openDoors(page, [door()]);

    await expect(page.getByText(/Since \d{2}:\d{2} club time/)).toBeVisible();
    await expect(page.getByText("4 released · 1 refused")).toBeVisible();
  });

  /** A zero on a failed count is the admin-failed-read defect with a different noun. */
  test("says the scan count could not be read rather than showing a zero", async ({ page }) => {
    await openDoors(page, [door()], [], { today: { [DOOR_ID]: null } });

    await expect(page.getByText("Today's scans could not be read.")).toBeVisible();
    await expect(page.getByText(/0 released/)).toHaveCount(0);
  });

  test("offers nothing that sorts the doors, at any width", async ({ page }) => {
    await openDoors(page, [door(), door({ id: OTHER_ID, name: "Front door", gate_key: "front-door" })]);

    await expect(page.getByRole("button", { name: /sort/i })).toHaveCount(0);
    await expect(page.getByRole("combobox")).toHaveCount(0);
  });

  /**
   * The failed read must not render the empty sentence: an admin who reads "no doors" while
   * a door is shut goes looking for a board that is fine.
   */
  test("separates a failed read from an empty club", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      ...routes([]).filter((r) => r.path !== "/api/v1/admin/doors"),
      { path: "/api/v1/admin/doors", status: 503, body: {} },
    ]);
    await page.goto("/admin/doors");

    await expect(page.getByRole("alert")).toContainText("Nothing has changed at the doors themselves");
    await expect(page.getByText("No doors have called in yet.")).toHaveCount(0);
  });

  /** Every target on a screen used standing up in a corridor. */
  test("keeps every control at 44 px and the page inside the phone", async ({ page }) => {
    await openDoors(page, [door({ gate_key: "a".repeat(64), name: "The changing room corridor door" })]);

    // Scoped to the page's own content. The app chrome's brand link and tab strip are
    // `Layout`'s and predate this surface; A2.7's 44 px rule is about the doors pages.
    const main = page.getByRole("main");
    for (const control of await main.getByRole("button").all()) {
      const box = await control.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
    for (const link of await main.getByRole("link").all()) {
      const box = await link.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});

test.describe("Shutting every door", () => {
  /**
   * <b>W1.5's whole point, in a browser.</b> The server did the work atomically; whether each
   * DOOR knows is a separate fact, and a result that said "2 doors shut" and stopped would be
   * true of the database and false of the corridor.
   */
  test("shows a per-door receipt, confirmed and NOT CONFIRMED, and takes focus", async ({ page }) => {
    const doors = [
      door({ last_seen_at: ago(12) }),
      door({ id: OTHER_ID, name: "Front door", gate_key: "front-door", last_seen_at: ago(6 * 3600), power_loss_behaviour: "released" }),
    ];
    await openDoors(page, doors, [
      {
        method: "POST",
        path: "/api/v1/admin/doors/shut-all",
        body: {
          doors: doors.map((d) => ({
            id: d.id, name: d.name, gate_key: d.gate_key, enabled: false,
            last_seen_at: d.last_seen_at, offline_after_seconds: 180,
            power_loss_behaviour: d.power_loss_behaviour,
          })),
        },
      },
    ]);

    await page.getByRole("button", { name: /— every door the club has open/ }).click();
    await page.getByRole("button", { name: /again to confirm/ }).click();

    const heading = page.getByRole("heading", { name: /2 doors shut — 1 confirmed, 1 not/ });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(page.getByText(/confirmed — heard from \d+s ago/)).toBeVisible();
    await expect(page.getByText(/NOT CONFIRMED — last heard/))
      .toContainText("It may still admit booked members from its cached list for up to six hours.");
    await expect(page.getByText("With no power this door is: released.")).toBeVisible();
    await expect(page.getByText(/Getting out is mechanical/).first()).toBeVisible();
  });

  /**
   * <b>The receipt is a receipt.</b> Rendered at T and inspected later, it still shows the
   * ages it was rendered with: a panel that drifted "confirmed 12 s ago" into "confirmed 10 m
   * ago" would be re-deciding, on the client, a question only the server could answer.
   */
  test("does not let its ages drift after it is rendered", async ({ page }) => {
    const only = door({ last_seen_at: ago(12) });
    await openDoors(page, [only], [
      {
        method: "POST",
        path: "/api/v1/admin/doors/shut-all",
        body: {
          doors: [{
            id: only.id, name: only.name, gate_key: only.gate_key, enabled: false,
            last_seen_at: only.last_seen_at, offline_after_seconds: 180,
            power_loss_behaviour: "not_established",
          }],
        },
      },
    ]);

    await page.getByRole("button", { name: /— every door the club has open/ }).click();
    await page.getByRole("button", { name: /again to confirm/ }).click();

    const line = page.getByText(/confirmed — heard from/);
    await expect(line).toBeVisible();
    const first = await line.textContent();
    await page.waitForTimeout(3000);
    await expect(line).toHaveText(first ?? "");
  });

  /** The way back is on the same screen as the way in, once some doors are shut. */
  test("names what is still open and offers a reopen beside it", async ({ page }) => {
    await openDoors(page, [
      door(),
      door({ id: OTHER_ID, name: "Front door", gate_key: "front-door", enabled: false }),
    ]);

    await expect(page.getByText("2 doors · 1 open, 1 shut")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Shut the 1 door still open — every door the club has open — 1 of 2/ })).toBeVisible();
    // C1: Front door was shut on its OWN, and `reopen-all` reopens only what a shut-all
    // shut — so a fleet reopen here would answer `{"doors":[]}` and print "0 doors
    // reopened". It is not offered; the panel says where the way back actually is.
    await expect(page.getByRole("button", { name: /shut together/ })).toHaveCount(0);
    await expect(page.getByText(/Front door was shut on its own/)).toBeVisible();
  });

  /**
   * <b>A1.5 / D5.</b> Shut-all has no timed auto-reopen, so without a standing banner a club
   * discovers the state at 05:50 with thirty members outside — and it is on EVERY admin
   * route, not only the doors pages.
   */
  test("banners a shut club on an admin route that has nothing to do with doors", async ({ page }) => {
    await signIn(page);
    await serveApi(page, routes([door({ enabled: false })]));
    await page.goto("/admin/settings");

    // C11: `role="status"` since this round — a standing fact is not an interruption, and
    // this one was re-announced assertively on every route an admin moved to.
    const banner = page.locator('[role="status"]').filter({ hasText: "1 of 1 door shut" });
    await expect(banner).toContainText("1 of 1 door shut");
    // C2: the phrase is banned outright — a shut door the club cannot reach has not heard
    // the refusal and goes on admitting booked members from its saved list.
    await expect(banner).not.toContainText("can't get in");
    // C1: shut on its own, so a fleet reopen would reopen nothing and is not offered.
    await expect(banner).toContainText("would not touch these");
    await expect(page.getByRole("link", { name: "Side door" }))
      .toHaveAttribute("href", `/admin/doors/${DOOR_ID}`);
  });
});

test.describe("One door's page", () => {
  /** Moved from admin-devices.spec.ts, with the control. */
  test("names a door and its door name in one call, and says so", async ({ page }) => {
    const unnamed = door({ gate_key: null, name: "Door gate", auto_registered: true });
    await openDoor(page, [unnamed], [
      {
        method: "PATCH",
        path: "/api/v1/admin/devices/",
        body: { ...unnamed, name: "Front door", gate_key: "front-door", auto_registered: false },
      },
    ]);

    await expect(page.getByText("Needs a door name")).toBeVisible();
    await page.getByRole("button", { name: /^Edit / }).click();
    await page.getByLabel("What the club calls it", { exact: true }).fill("Front door");
    await page.getByLabel(/Name the board uses offline/).fill("front-door");

    const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/admin/devices/"));
    // Re-served WITH the PATCH route: `serveApi` replaces the whole table, and a re-serve
    // that drops the route the click is about answers the click with "no route for PATCH".
    await serveApi(page, routes([{ ...unnamed, name: "Front door", gate_key: "front-door", auto_registered: false }], [
      {
        method: "PATCH",
        path: "/api/v1/admin/devices/",
        body: { ...unnamed, name: "Front door", gate_key: "front-door", auto_registered: false },
      },
    ]));
    await page.getByRole("button", { name: /Save this door/ }).click();

    // Name and door key in one call, and no court_numbers — the API refuses that field here.
    expect(JSON.parse((await patch).postData() ?? "{}")).toEqual({
      name: "Front door", gate_key: "front-door", location_note: "", power_loss_behaviour: "not_established",
    });
    await expect(page.getByRole("status").first())
      .toContainText("Front door saved. It is the front-door door");
  });

  /**
   * <b>Clearing a door's name, against a server that behaves like the API.</b> The screen
   * sent `gate_key: null`, which `UpdateAsync` reads as "leave it alone", so the clear was a
   * silent no-op that reported success — and neither the spec nor the unit test could see it,
   * because both answered the PATCH with an already-cleared row whatever they were handed.
   */
  test("clears a door name for real, rather than reporting a save the API discards", async ({ page }) => {
    let row: Record<string, unknown> = door({ name: "Front door", gate_key: "front-door" });
    const aware: ApiRoute[] = [
      { path: "/api/v1/admin/doors", respond: () => doorsView([row]) },
      {
        method: "PATCH",
        path: "/api/v1/admin/devices/",
        respond: (request) => {
          const patch = (request.body ?? {}) as Record<string, unknown>;
          // The API's rule, verbatim: null is an absence, "" is the clear.
          if (typeof patch.name === "string") row = { ...row, name: patch.name };
          if (typeof patch.gate_key === "string") {
            const trimmed = patch.gate_key.trim();
            row = { ...row, gate_key: trimmed === "" ? null : trimmed };
          }
          return row;
        },
      },
    ];

    await signIn(page);
    await serveApi(page, [...routes([]).filter((r) => r.path !== "/api/v1/admin/doors"), ...aware]);
    await page.goto(`/admin/doors/${DOOR_ID}`);
    await expect(page.getByText(/front-door · gate-0a1b2c/)).toBeVisible();

    const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/admin/devices/"));
    await page.getByRole("button", { name: /^Edit / }).click();
    await page.getByLabel(/Name the board uses offline/).fill("   ");
    await page.getByRole("button", { name: /Save this door/ }).click();

    // A19: one form over all four writable fields, so one PATCH carrying all four. `""`,
    // not `null`, on both two-valued fields — a null is what the API reads as "leave it
    // alone", and that is what the page used to send while reporting a success.
    expect(JSON.parse((await patch).postData() ?? "{}")).toEqual({
      name: "Front door", gate_key: "", location_note: "", power_loss_behaviour: "not_established",
    });
    await expect(page.getByText(/no door name yet · gate-0a1b2c/)).toBeVisible();
    // And what the club has just given up: an unnamed door is sent an empty list, so it has
    // no offline fallback at all.
    await expect(page.getByRole("status").first()).toContainText("only works while it can reach the server");
  });

  /**
   * The shut copy, which is the door's own and shares nothing with the box's — and states
   * BOTH halves, because either alone is a sentence an admin cannot reconcile with what they
   * will see.
   */
  test("says what shutting a DOOR costs, and none of what it costs a box", async ({ page }) => {
    await openDoor(page, [door({ name: "Front door", gate_key: "front-door" })]);

    // B4 / R3-24: it used to open "The club is not alerted about its silence…" — a clause
    // with no subject, about ALERTS, under a heading about shutting a door. Both halves are
    // still said; the order and the subject changed.
    const notice = page.getByText(/^Shutting a door refuses every scan at it/);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("can still reach the club hears that refusal and opens for nobody");
    await expect(notice).toContainText("has also lost the network never hears it");
    await expect(notice).toContainText("up to six hours");
    await expect(notice).toContainText("stops raising its silence as a fault");
    // A1.1: the denial survives P5's ban on the tokens.
    await expect(notice).toContainText("a door marks nobody as having arrived");
    await expect(notice).not.toContainText("check-in");
    await expect(notice).not.toContainText("attendance");
    // And none of the court box's copy, which is false of a door in every clause.
    await expect(notice).not.toContainText("refunded in full");
    await expect(page.getByText(/The API refuses this box/)).toHaveCount(0);
    await expect(notice).not.toContainText("the API");

    // A1.4: one name for the 403 path on a gate.
    await expect(page.getByRole("button", { name: "Shut this door — Front door" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Take out of service/ })).toHaveCount(0);
  });

  /**
   * <b>B13 / R3-34: and what this page last READ, so a stale tab is refused.</b>
   *
   * Still only those two keys — no name, no gate key, no court fields. `expected_enabled` is
   * the negation of the request by construction: a control offering "Shut" was rendered from
   * a door the page read as open.
   */
  test("sends only enabled, and what it expected, when a door is shut", async ({ page }) => {
    const only = door({ name: "Front door", gate_key: "front-door" });
    await openDoor(page, [only], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...only, enabled: false } },
    ]);

    const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/admin/devices/"));
    await page.getByRole("button", { name: "Shut this door — Front door" }).click();
    await page.getByRole("button", { name: "Shut this door — Front door — choose again to confirm" }).click();

    expect((await patch).postData()).toBe('{"enabled":false,"expected_enabled":true}');
  });

  /**
   * <b>D4, on a real screen.</b> The derivation names a credential; the flag must not. No
   * member name and no eight-hex fingerprint anywhere on a page rendering a signal.
   */
  test("renders a signal that identifies nobody", async ({ page }) => {
    await openDoor(page, [door({ name: "Front door" })], [], {
      signals: { [DOOR_ID]: [{ kind: "may_not_be_releasing", since: ago(50), until: ago(0), scans: 4 }] },
    });

    const notice = page.getByText(/Front door may not be releasing/);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("people do not scan again when a door opens");
    await expect(notice).toContainText("The release is set to 3 seconds.");
    const text = (await notice.textContent()) ?? "";
    expect(text).not.toMatch(/\b[0-9a-f]{8}\b/);
    expect(text).not.toContain("Ada");
  });

  /** A2.5's other half: deleting a door lives here now, and says what comes back. */
  test("says a deleted door comes back unnamed", async ({ page }) => {
    await openDoor(page, [door({ name: "Front door" })]);

    await page.getByRole("button", { name: "Delete this door — Front door" }).click();
    await expect(page.getByRole("button", { name: "Delete this door — Front door — choose again to confirm" })).toBeVisible();
    // The armed button IS the confirm sentence — asserted on the control rather than on a
    // text node, because the width sentinel carries the same words invisibly.
    const armed = page.getByRole("button", { name: "Delete this door — Front door — choose again to confirm" });
    await expect(armed).toBeVisible();
    // C10's two facts, in the words A2 gave them this round: the armed confirm was a
    // paragraph, and what it listed it destroyed while saying nothing about the door's
    // history — so a reviewer concluded, reasonably, that the scans went too.
    // B5 (round 2): the consequence is the paragraph above the two buttons, not the button.
    const told = armed.locator("xpath=..").locator("> p");
    await expect(told).toContainText("its place and its power answer go");
    // A2: the question a reviewer went looking for and could not find an answer to.
    await expect(told).toContainText("Its past scans stay in the club log");
  });

  /** Fifty rows of decisions, each carrying a member name of a length nobody controls. */
  test("does not push the page sideways on fifty feed rows and a long member name", async ({ page }) => {
    const longName = "Bartholomew Fitzgerald-Montgomery-Wetherby-Ashcombe-Pemberton";
    const rows = Array.from({ length: 50 }, (_, i) => ({
      at: new Date(Date.now() - i * 60_000).toISOString(),
      action: i % 2 === 0 ? "gate.opened" : "gate.denied_member_not_active",
      reason: i % 2 === 0 ? "ok" : "member_not_active",
      offline: false,
      member: { id: "00000000-0000-0000-0000-0000000000aa", name: longName },
      fingerprint: "1f2e3d4c",
    }));

    await signIn(page);
    await serveApi(page, [
      ...routes([door()]).filter((r) => r.path !== `/api/v1/admin/devices/${DOOR_ID}/activity`),
      { path: `/api/v1/admin/devices/${DOOR_ID}/activity`, body: { items: rows } },
    ]);
    await page.goto(`/admin/doors/${DOOR_ID}`);

    await expect(page.getByText(longName).first()).toBeVisible();
    // A1.2 on a real row: the chip says what the board reported, not that the door moved.
    await expect(page.getByText("Lock released").first()).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});

test.describe("The club door log", () => {
  const logRow = (overrides: Record<string, unknown> = {}) => ({
    at: ago(600),
    action: "gate.denied_no_booking",
    reason: "no_booking",
    offline: false,
    member: { id: "00000000-0000-0000-0000-0000000000aa", name: "Ada Lovelace" },
    fingerprint: "1f2e3d4c",
    door: { id: DOOR_ID, name: "Side door", gate_key: "side-door" },
    ...overrides,
  });

  async function openLog(page: Page, items: unknown[], extra: ApiRoute[] = [], url = "/admin/doors/log") {
    await signIn(page);
    await serveApi(page, [
      ...routes([door()]).filter((r) => r.path !== "/api/v1/admin/doors/activity"),
      { path: "/api/v1/admin/doors/activity", body: { items, next_cursor: null, retention_days: 90 } },
      ...extra,
    ]);
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "All scans, all doors" })).toBeVisible();
  }

  /**
   * <b>P3 as an absence, in a real DOM.</b> The way this rule breaks is not a decision — it
   * is `DataTable`'s `search` prop putting the member's name in the filter string, or a sort
   * control on the who column, which is the same filter in another shape.
   */
  test("filters by door, time and outcome and by nothing else", async ({ page }) => {
    await openLog(page, [logRow()]);

    await expect(page.getByLabel("Door", { exact: true })).toBeVisible();
    // A7 put a visible clock face on every row with an sr-only "When: <date>" label, so a
    // loose "When" now matches the filter AND every row. Exact, which is what this
    // assertion always meant: the three FILTERS, and no fourth.
    await expect(page.getByLabel("When", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Outcome", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveCount(3);
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.locator("table")).toHaveCount(0);
    await expect(page.getByText(/It does not filter by member/)).toBeVisible();
  });

  test("carries both P2 banners and the club's own retention number", async ({ page }) => {
    await openLog(page, [logRow()]);

    await expect(page.getByText(/not who walked through/)).toBeVisible();
    await expect(page.getByText(/no door sensor/)).toBeVisible();
    await expect(page.getByText(/kept for 90 days/)).toBeVisible();
  });

  test("reads a pre-filtered door out of the query string", async ({ page }) => {
    await openLog(page, [logRow()], [], `/admin/doors/log?door=${DOOR_ID}`);

    await expect(page.getByLabel("Door")).toHaveValue(DOOR_ID);
  });

  /**
   * The CSV goes out with the session's token. A bare `<a download>` navigates with no
   * Authorization header at all, so the API cannot resolve a tenant, the download cancels
   * itself, and the page looks identical before and after — the defect this product already
   * shipped once on the wallet CSV.
   */
  test("downloads the CSV with the bearer token and the list's own filters", async ({ page }) => {
    await openLog(page, [logRow()], [
      {
        path: "/api/v1/admin/doors/activity.csv",
        body: "at,door,door_name,outcome,reason,offline,member,fingerprint\n",
      },
    ]);

    const csv = page.waitForRequest((r) => r.url().includes("activity.csv"));
    await page.getByRole("button", { name: "Download CSV" }).click();
    const request = await csv;
    expect(await request.headerValue("authorization")).toContain("Bearer");
  });

  test("says at the button what a downloaded file carries", async ({ page }) => {
    await openLog(page, [logRow()]);

    // B3 / A15: the note promised "the same rows as this page" over a file that holds
    // everything matching the filters — 50 on screen, 165 in the reviewer's download.
    const note = page.getByText(/every scan matching the filters above/);
    await expect(note).toContainText("not just the rows on this page");
    await expect(note).toContainText("outside the club's 90-day rule");
    await expect(page.getByText(/same rows as this page/)).toHaveCount(0);
  });

  /** The one-door empty case — the answer to the spec's own question. */
  test("answers an empty one-door range with the possibility an admin came to check", async ({ page }) => {
    await openLog(page, [], [], `/admin/doors/log?door=${DOOR_ID}`);

    await expect(page.getByText(/No scans at Side door between/))
      .toContainText("It is reporting, so the club is hearing from it");
  });

  test("keeps the page inside the phone with a long member name on every row", async ({ page }) => {
    const longName = "Bartholomew Fitzgerald-Montgomery-Wetherby-Ashcombe-Pemberton";
    await openLog(page, Array.from({ length: 20 }, (_, i) => logRow({
      at: new Date(Date.now() - i * 60_000).toISOString(),
      member: { id: "00000000-0000-0000-0000-0000000000aa", name: longName },
    })));

    await expect(page.getByText(longName).first()).toBeVisible();
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});

test.describe("The printable door card", () => {
  /**
   * <b>A refusal rather than an omission.</b> The club's device key registers boards, reads
   * heartbeats and pulls the whole roster once a door is named — and this card lives on a
   * wall in a corridor.
   */
  test("carries what somebody at the door needs, and no credential and no member", async ({ page }) => {
    await signIn(page);
    await serveApi(page, routes([door({
      location_note: "In the cupboard above the fuse board", power_loss_behaviour: "released",
    })]));
    await page.goto(`/admin/doors/${DOOR_ID}/card`);

    // B22 / C13: the club's OWN name for the door is the headline, slug beneath. The
    // heading used to BE the slug — "side-door" in 36 px on a card taped to a wall.
    await expect(page.getByRole("heading", { name: "Side door" })).toBeVisible();
    await expect(page.getByText("side-door", { exact: true })).toBeVisible();
    await expect(page.getByText("gate-0a1b2c")).toBeVisible();
    await expect(page.getByText("In the cupboard above the fuse board")).toBeVisible();
    await expect(page.getByText(/RELEASED/)).toBeVisible();
    await expect(page.getByText("076 226 1390")).toBeVisible();
    await expect(page.getByText(/Check it is still right/)).toBeVisible();

    await expect(page.getByText(/cmk_/)).toHaveCount(0);
    await expect(page.getByText("Ada Lovelace")).toHaveCount(0);
  });

  /**
   * The product's only print stylesheet. Without it a browser prints the sticky header, the
   * tab strip and a page of chrome around a card 80 mm tall.
   */
  test("hides the app chrome and its own controls when printed", async ({ page }) => {
    await signIn(page);
    await serveApi(page, routes([door()]));
    await page.goto(`/admin/doors/${DOOR_ID}/card`);
    await expect(page.getByRole("heading", { name: "Side door" })).toBeVisible();

    await page.emulateMedia({ media: "print" });
    await expect(page.locator("header")).toBeHidden();
    await expect(page.getByRole("button", { name: /Print/ })).toBeHidden();
    await expect(page.getByRole("heading", { name: "Side door" })).toBeVisible();
    await page.emulateMedia({ media: "screen" });
  });
});

/**
 * <b>B7 / C6 — the armed confirm was clipped, and only a browser can say so.</b>
 *
 * <p>
 * Five reviewers drove the real product; two of them, independently, found that arming any
 * destructive doors control produced a box of the same 44 px it had at rest with four lines of
 * consequence inside it. Measured on a phone: `clientHeight 44, scrollHeight 106`. What was cut
 * off was not decoration — it was the half of the sentence that says a door which has lost the
 * network keeps admitting booked members for up to six hours, i.e. the part that decides whether
 * shutting the door does what the admin thinks it does.
 * </p>
 *
 * <p>
 * <b>Why the vitest suite could not see it and this can.</b> jsdom computes no layout at all, so
 * `scrollHeight` and `clientHeight` are both 0 there and any assertion about them passes on a
 * component that clips everything. `components/confirm-button-armed.test.tsx` holds the three
 * DOM properties the pixels depend on — no `overflow-hidden`, the showing label in normal flow,
 * a caller's fixed `h-11` refused — and this is the measurement itself. Both are needed: the
 * jsdom half runs on every commit and names the cause, this half proves the effect.
 * </p>
 *
 * <p>
 * Two widths, because the failure was width-dependent: the narrower the control, the more lines
 * the consequence takes and the more of it a fixed height swallowed. 360 px is the narrowest
 * phone the product supports and 768 px is where the doors grid becomes two columns, which makes
 * each control narrow again on a screen nobody thinks of as small.
 * </p>
 */
test.describe("An armed doors confirm fits the words it is showing", () => {
  const WIDTHS = [
    { label: "360 px", width: 360, height: 740 },
    { label: "768 px", width: 768, height: 1024 },
  ];

  /**
   * The control is armed; measure it rather than look at it.
   *
   * `scrollHeight <= clientHeight + 1` is the whole finding — a control whose content is taller
   * than its box is a control hiding part of what it is about to do. The 1 px allowance is for
   * sub-pixel rounding of a fractional line height, nothing more; the failure this catches was
   * 52 to 62 px over.
   *
   * 14 px is the other half: the type was `text-xs`, and a 12 px consequence on a phone is the
   * reason it needed four lines in the first place.
   */
  /**
   * <b>Found by shape, not by wording.</b> Every `ConfirmButton` is a wrapper holding its
   * control and the polite live region that replaced `aria-pressed`, so this selector is every
   * two-step confirm on the page and nothing else.
   *
   * <p>
   * An earlier draft of this sweep named each control by its label, and the labels changed
   * under it inside one afternoon — "Delete Front door" became "Delete this door — Front door"
   * while this was being written. A layout guarantee that only holds for the wording it was
   * written against is not a guarantee; a control that arrives on this screen next month gets
   * measured by this test without anybody remembering to add it.
   * </p>
   */
  const CONFIRMS = 'div:has(> span[aria-live="polite"])';

  /**
   * Arm every confirm on the page in turn, measure it, and put it back.
   *
   * `scrollHeight <= clientHeight + 1` is the whole finding — a control whose content is taller
   * than its box is a control hiding part of what it is about to do. The 1 px allowance is for
   * sub-pixel rounding of a fractional line height, nothing more; the failure this catches was
   * 52 to 62 px over. 14 px is the other half: the type was `text-xs`, and a 12 px consequence
   * on a phone is the reason it needed four lines in the first place.
   */
  async function everyConfirmFits(page: Page, expected: number) {
    const wrappers = page.locator(CONFIRMS);
    await expect(wrappers).toHaveCount(expected);

    for (let i = 0; i < expected; i += 1) {
      const wrapper = wrappers.nth(i);
      const trigger = wrapper.locator("> button").first();
      // `innerText`, not `textContent`: the width sentinel inside the control is
      // visibility-hidden and carries a copy of BOTH labels, which textContent would hand back.
      const idleText = (await trigger.evaluate((el) => (el as HTMLElement).innerText)).trim();

      await trigger.click();
      // Armed: the wrapper now holds the control and its way out.
      await expect(wrapper.locator("> button")).toHaveCount(2);

      // By ROLE in the armed pair, not by position: C-H1 put the way out FIRST, so that the
      // natural Tab out of the auto-focused safe button reaches the other option instead of
      // leaving the control. An index here measures whichever button happens to be there.
      const control = wrapper.locator('> button[data-confirm="go"]');
      const measured = await control.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
        shown: (el as HTMLElement).innerText.trim(),
        pressed: el.getAttribute("aria-pressed"),
        name: el.getAttribute("aria-label"),
      }));

      // B5 (round 2): the consequence is a paragraph ABOVE the two buttons, not the armed
      // button's own words — the button says what pressing it does, in a word or two.
      const consequence = wrapper.locator("> p");
      await expect(consequence, `confirm ${i} ("${idleText}") shows no consequence`).toBeVisible();
      const told = (await consequence.innerText()).trim();
      expect(told.length, `confirm ${i} ("${idleText}") shows no consequence`).toBeGreaterThan(0);
      expect(told.split(/\s+/).length, `confirm ${i} ("${idleText}") runs past 25 words: "${told}"`)
        .toBeLessThanOrEqual(25);
      expect(measured.shown.length, `confirm ${i} ("${idleText}") armed with an empty control`)
        .toBeGreaterThan(0);
      expect(
        measured.scrollHeight,
        `confirm ${i} ("${idleText}") clips its own words: scrollHeight ${measured.scrollHeight}`
        + ` > clientHeight ${measured.clientHeight}`,
      ).toBeLessThanOrEqual(measured.clientHeight + 1);
      expect(measured.fontSize, `confirm ${i} ("${idleText}") is smaller than 14 px`)
        .toBeGreaterThanOrEqual(14);
      // B6: "pressed" is the word for done, and nothing has been done yet.
      expect(measured.pressed, `confirm ${i} ("${idleText}") claims a pressed state`).toBeNull();
      // B16: whatever the call site adds, the words on the control come first.
      if (measured.name !== null) {
        expect(measured.name.startsWith(idleText), `"${measured.name}" does not open with "${idleText}"`)
          .toBe(true);
      }
      // B6 again: the consequence is announced, not left to the visual alone.
      expect((await wrapper.locator('span[aria-live="polite"]').innerText()).trim().length)
        .toBeGreaterThan(0);

      // C10: a visible way out, at a real touch size.
      const cancel = wrapper.locator('> button[data-confirm="stop"]');
      await expect(cancel).toBeVisible();
      expect((await cancel.boundingBox())!.height, `confirm ${i}'s Cancel is under 44 px`)
        .toBeGreaterThanOrEqual(44);

      await cancel.click();
      await expect(wrapper.locator("> button")).toHaveCount(1);
    }
  }

  for (const size of WIDTHS) {
    test(`every confirm on the doors overview does at ${size.label}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      // One door open and one shut BY A SHUT-ALL, so the fleet panel renders both halves at
      // once. `shut_by_shut_all_at` is what makes the Reopen exist — C1: a door shut on its
      // own is not something `reopen-all` touches, so no control for it is offered.
      await openDoors(page, [
        door(),
        door({
          id: OTHER_ID, name: "Front door", gate_key: "front-door", enabled: false,
          shut_by_shut_all_at: ago(120),
        }),
      ]);

      await everyConfirmFits(page, 2);
    });

    test(`every confirm on an open door's page does at ${size.label}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await openDoor(page, [door({ name: "Front door" })]);

      // Shut this door, and Delete.
      await everyConfirmFits(page, 2);
    });

    test(`a shut door's reopen confirm does at ${size.label}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await openDoor(page, [door({ name: "Front door", enabled: false })]);

      // Reopen this door, and Delete.
      await everyConfirmFits(page, 2);
    });
  }
});

/**
 * <b>Round 2 — what is true but unsafe at the edges.</b>
 *
 * <p>
 * R1 fixed what was false. R2 found deleted things, pages left open, two reads failing
 * together, and copy about a door in general rather than about THIS door. Every case below
 * is one a browser can see and jsdom cannot: a page that unmounts to white, a card that
 * moves under a thumb between polls, a control two screens below the thing it acts on, a
 * timer that has to be a real timer, and a target measured in pixels.
 * </p>
 */
test.describe("A door that has been deleted", () => {
  const REMOVED_KEY = "gate-44c103";

  const removedRow = (overrides: Record<string, unknown> = {}) => ({
    at: ago(600),
    action: "gate.opened",
    reason: "ok",
    offline: false,
    member: { id: "00000000-0000-0000-0000-0000000000aa", name: "Ada Lovelace" },
    fingerprint: "1f2e3d4c",
    // WIRE-R2 §1: no id, the name and key the row stored at write time, and `removed`.
    door: { id: null, name: "Side door", gate_key: "side-door", removed: true },
    ...overrides,
  });

  async function openLog(page: Page, items: unknown[], body: Record<string, unknown> = {}) {
    await signIn(page);
    await serveApi(page, [
      ...routes([door()]).filter((r) => r.path !== "/api/v1/admin/doors/activity"),
      {
        path: "/api/v1/admin/doors/activity",
        body: {
          items, next_cursor: null, retention_days: 90, timezone: "Africa/Johannesburg", ...body,
        },
      },
    ]);
    await page.goto("/admin/doors/log");
  }

  /**
   * <b>A1 / E-C1 / C1 — the critical, and the only test that reproduces it as a reader met
   * it.</b>
   *
   * A reviewer deleted a door and `/admin/doors/log` became a blank white document for
   * everybody in the club: rows arrived with a null door, the page read `.name` off it, React
   * unmounted the whole tree and Back landed on `/schedule`. Found independently by three
   * reviewers. The rows survive their board, and so does the page.
   */
  test("keeps the log on its feet and names the door that is gone", async ({ page }) => {
    await openLog(page, [removedRow()]);

    await expect(page.getByRole("heading", { name: "All scans, all doors" })).toBeVisible();
    await expect(page.getByText(/since been removed/)).toBeVisible();
    await expect(page.getByText("Ada Lovelace")).toBeVisible();
  });

  /**
   * The neighbouring edge, which is the one the round's own lesson names: a row from an API
   * that sends the field as a bare null, and one with every nullable field nulled. Neither
   * may be allowed to take the page down, and neither may invent a name.
   */
  test("survives a row with no door at all, and one with nothing filled in", async ({ page }) => {
    await openLog(page, [
      removedRow({ door: null, member: null, reason: null, fingerprint: null }),
      removedRow({ door: { id: null, name: null, gate_key: null, removed: true }, member: null }),
    ]);

    await expect(page.getByRole("heading", { name: "All scans, all doors" })).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByText("null")).toHaveCount(0);
    await expect(page.getByText("undefined")).toHaveCount(0);
  });

  /**
   * <b>A2 — the history is not destroyed, and there has to be a way to it.</b>
   *
   * A reviewer concluded the club's records had been deleted with the board. They had not:
   * the rows stay until the retention rule takes them. The picker is how somebody reaches
   * them, and it filters by the key the rows stored rather than by an id that no longer
   * exists.
   */
  test("offers the removed door in the picker and filters by the key its rows stored", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/admin/doors/activity")) asked.push(r.url()); });
    await openLog(page, [removedRow()], {
      removed_doors: [{ key: REMOVED_KEY, name: "Side door", gate_key: "side-door" }],
    });
    await expect(page.getByRole("heading", { name: "All scans, all doors" })).toBeVisible();

    await page.getByLabel("Door").selectOption(`removed:${REMOVED_KEY}`);

    await expect.poll(() => asked.some((u) => u.includes(`removed_door=${REMOVED_KEY}`))).toBe(true);
    // Never both parameters: the API answers 400 for the pair.
    // `includes("door=")` also matches `removed_door=`, so the pair is checked on the
    // parameter itself rather than on a substring of another parameter's name.
    expect(asked.filter((u) => u.includes("removed_door=") && /[?&]door=/.test(u))).toHaveLength(0);
  });
});

test.describe("The log a committee reads", () => {
  const logRow = (overrides: Record<string, unknown> = {}) => ({
    at: "2026-09-19T22:30:00Z",
    action: "gate.opened",
    reason: "ok",
    offline: false,
    member: { id: "00000000-0000-0000-0000-0000000000aa", name: "Ada Lovelace" },
    fingerprint: "1f2e3d4c",
    door: { id: DOOR_ID, name: "Side door", gate_key: "side-door", removed: false },
    ...overrides,
  });

  async function openLog(page: Page, body: Record<string, unknown> = {}) {
    const asked: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/admin/doors/activity")) asked.push(r.url()); });
    await signIn(page);
    await serveApi(page, [
      ...routes([door()]).filter((r) => r.path !== "/api/v1/admin/doors/activity"),
      {
        path: "/api/v1/admin/doors/activity",
        body: {
          items: [logRow()],
          next_cursor: null,
          retention_days: 90,
          total: 70,
          timezone: "Africa/Johannesburg",
          // UTC instants, as the API sends them — NOT club-offset. 22:00 UTC on the 18th
          // is midnight on the 19th in the club's zone, which is what the page must print.
          range: { from: "2026-09-18T22:00:00Z", to: "2026-09-19T22:00:00Z" },
          ...body,
        },
      },
    ]);
    await page.goto("/admin/doors/log");
    await expect(page.getByRole("heading", { name: "All scans, all doors" })).toBeVisible();
    return asked;
  }

  /**
   * <b>A6.</b> "50 scans, newest first" read as a total over a 70-row range — and that is the
   * number an admin repeats to a committee after an incident.
   */
  test("says how many of the range it is showing, not how many it fetched", async ({ page }) => {
    await openLog(page);

    await expect(page.getByText("Showing 1 of 70 scans in this range, newest first.")).toBeVisible();
  });

  /**
   * <b>A7 / E-M5.</b> Every row printed "6m ago" with the exact time in a `title` — which is
   * invisible on a phone, to a screen reader, and to anybody using touch. The clock face is
   * visible; the age is secondary.
   */
  test("shows a clock time on the row itself rather than in a tooltip", async ({ page }) => {
    await openLog(page);

    // 22:30 UTC is 00:30 the next day in the club's zone, so this is also the day boundary.
    await expect(page.getByText("00:30", { exact: false }).first()).toBeVisible();
  });

  /**
   * <b>A4 — "yesterday" is a calendar question and the club's midnight is the server's.</b>
   *
   * A chair exporting "yesterday's" scans after an incident was handed half of yesterday and
   * half of today, with nothing on the page or in the filename saying so.
   */
  test("asks the server for a named period and states the range it resolved", async ({ page }) => {
    const asked = await openLog(page);

    await page.getByLabel("When", { exact: true }).selectOption("yesterday");

    await expect.poll(() => asked.some((u) => u.includes("period=yesterday"))).toBe(true);
    // In words, above the rows, from the server's own resolved range — and rendered in the
    // club's zone, so a `…Z` midnight prints as 00:00 on the 19th rather than 22:00 on the
    // 18th. Getting this wrong puts a committee's "yesterday" on the wrong day.
    const line = page.getByText(/^Scans from .* to .*, club time\.$/);
    await expect(line).toContainText("19 Sept");
    await expect(line).toContainText("00:00");
    await expect(line).not.toContainText("22:00");
  });

  /** And one particular day, which the page had no way to ask for at all. */
  test("asks for one club-local day when that is the question", async ({ page }) => {
    const asked = await openLog(page);

    await page.getByLabel("When", { exact: true }).selectOption("day");
    await page.getByLabel("Which day").fill("2026-09-19");

    await expect.poll(() => asked.some((u) => u.includes("day=2026-09-19"))).toBe(true);
    expect(asked.filter((u) => u.includes("day=") && u.includes("period="))).toHaveLength(0);
  });

  /**
   * <b>C5.</b> The count lived in a `role="status"` that existed only while there were rows,
   * so narrowing the log to an EMPTY result announced nothing at all — the region left the
   * document and a screen-reader user was on a page that had silently changed under them.
   */
  test("keeps one polite region that is still there when the result is empty", async ({ page }) => {
    await openLog(page, { items: [], total: 0 });

    const regions = page.locator('[role="status"]');
    await expect(regions.filter({ hasText: /No scans|Showing/ })).toHaveCount(1);
  });
});

test.describe("A page somebody left open", () => {
  /*
    These wait for a real poll to come round — thirty seconds on an ordinary route, fifteen
    on the doors surface — so the per-test cap has to be larger than the interval by more
    than the margin a loaded machine eats. It defaults to 30 s, which is the interval
    itself: the banner case passed standalone and failed inside the full suite, where the
    poll landed a second the wrong side of the cap. A test that depends on the load on the
    machine is a test that reports the machine.
  */
  test.describe.configure({ timeout: 120_000 });

  /**
   * <b>B1 — the door page made zero repeat requests over seventy seconds</b> while its
   * relative clocks went on ticking: another admin's shut was invisible, "Shut this door" was
   * still offered for a door already shut, and no banner appeared. A real timer, in a real
   * event loop, is the only way to see this.
   */
  test("shows another admin's shut on the door page without a navigation", async ({ page }) => {
    let shut = false;
    await signIn(page);
    await serveApi(page, [
      ...routes([door()]).filter((r) => r.path !== "/api/v1/admin/doors"),
      {
        path: "/api/v1/admin/doors",
        respond: () => doorsView([door({ enabled: !shut, shut_by_name: shut ? "Priya Naidoo" : null })]),
      },
    ]);
    await page.goto(`/admin/doors/${DOOR_ID}`);
    await expect(page.getByRole("button", { name: /^Shut this door/ })).toBeVisible();
    await expect(page.getByText(/Re-reads every 15 seconds/)).toBeVisible();

    // Somebody else, in the club, shuts it.
    shut = true;

    await expect(page.getByRole("button", { name: /^Reopen this door/ })).toBeVisible({ timeout: 60_000 });
  });

  /**
   * <b>B2.</b> The site-wide shut banner re-read only on navigation, so it sat frozen on
   * `/schedule` while another admin shut every door in the club.
   */
  test("brings the shut banner to a page that has nothing to do with doors", async ({ page }) => {
    let shut = false;
    await signIn(page);
    await serveApi(page, [
      ...routes([door()]).filter((r) => r.path !== "/api/v1/admin/doors"),
      { path: "/api/v1/admin/bookings", body: [] },
      { path: "/api/v1/admin/courts", body: [] },
      {
        path: "/api/v1/admin/doors",
        respond: () => doorsView([door({ enabled: !shut, shut_by_shut_all_at: shut ? ago(30) : null })]),
      },
    ]);
    await page.goto("/schedule");
    await expect(page.getByText(/door shut/)).toHaveCount(0);

    shut = true;

    await expect(page.getByText(/1 of 1 door shut/)).toBeVisible({ timeout: 90_000 });
  });

  /**
   * <b>C11.</b> The banner was `role="alert"` on every route — assertive, interrupting a
   * screen reader mid-word, re-rendered on every navigation. A standing fact is polite.
   */
  test("states a standing shut politely rather than interrupting", async ({ page }) => {
    await openDoors(page, [door({ enabled: false, shut_by_shut_all_at: ago(120) })]);

    const polite = page.locator('[role="status"]').filter({ hasText: /door shut/ });
    await expect(polite).toHaveCount(1);
    // The assertive region exists so it CAN announce, and carries nothing on arrival.
    await expect(page.locator('[role="alert"]').filter({ hasText: /door shut/ })).toHaveCount(0);
  });

  /**
   * <b>E-L6.</b> `/admin/doors` fired three identical GETs on mount — the banner store, the
   * page and the gear badge, three readers of one fact.
   */
  test("reads the club's doors once on arrival, not once per reader", async ({ page }) => {
    // Counted off the request event rather than off a `page.route` handler: `serveApi`
    // installs a catch-all for `**/api/**` AFTER this, and Playwright gives the last
    // matching handler the request — so a counter installed first never runs at all, and
    // the test reads zero and passes for the wrong reason.
    let reads = 0;
    await signIn(page);
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/v1/admin/doors") reads += 1;
    });
    await serveApi(page, routes([door()]));
    await page.goto("/admin/doors");
    await expect(page.getByRole("heading", { name: "Doors", level: 1 })).toBeVisible();
    await expect(page.getByText("Reporting")).toBeVisible();

    expect(reads).toBe(1);
  });
});

test.describe("The overview under a thumb", () => {
  // Two of these wait for the doors page's own fifteen-second poll. See the note above.
  test.describe.configure({ timeout: 120_000 });

  /**
   * <b>A10.</b> The overview re-sorted by severity on every poll, so cards swapped position
   * under a thumb already on its way down — a reviewer tapped a door and landed on a
   * different one. Order is by name, and attention is carried by the chips and by a summary
   * line that LINKS to the door that needs somebody.
   */
  test("does not move a card when the door below it goes quiet", async ({ page }) => {
    let quiet = false;
    await signIn(page);
    await serveApi(page, [
      ...routes([door()]).filter((r) => r.path !== "/api/v1/admin/doors"),
      {
        path: "/api/v1/admin/doors",
        respond: () => doorsView([
          door({ id: OTHER_ID, name: "Alpha door", gate_key: "alpha" }),
          door({ name: "Zulu door", gate_key: "zulu", last_seen_at: quiet ? ago(3600) : ago(12) }),
        ]),
      },
    ]);
    await page.goto("/admin/doors");
    const alpha = page.getByRole("article", { name: "Alpha door" });
    await expect(alpha).toBeVisible();
    const before = await alpha.boundingBox();

    quiet = true;
    await expect(page.getByText(/Zulu door has not been heard from/)).toBeVisible({ timeout: 60_000 });

    const names = await page.getByRole("heading", { level: 3 }).allTextContents();
    expect(names).toEqual(["Alpha door", "Zulu door"]);
    // And the summary arriving reserved its own space rather than pushing the cards down.
    const after = await alpha.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2);
    await expect(page.getByRole("link", { name: "Go to Zulu door" })).toBeVisible();
  });

  /**
   * <b>A13.</b> A door called "A" gave a 34 px link — under the 44 px target this whole
   * surface is built to, on the one control a card exists to offer, and the shorter the name
   * the smaller the target got.
   */
  test("gives a one-letter door name a full-sized target", async ({ page }) => {
    await openDoors(page, [door({ name: "A", gate_key: "a" })]);

    const link = page.getByRole("link", { name: "A", exact: true });
    const box = await link.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
  });

  /**
   * <b>Found in the look pass, at the size the look pass exists for.</b>
   *
   * <p>
   * At 320 px with a 32 px root font — the large-text setting an older volunteer actually
   * uses — the state chip painted ON TOP of the door's name: "Sid[Reporting]e door". The
   * card header is a two-column grid whose chip column is `auto`, so it refuses to shrink;
   * the name column, correctly `minmax(0,1fr)`, collapsed to nothing and its text spilled
   * out under the chip. B14 put the chips in that grid so four cards at tablet width stop
   * laying their headers out four different ways, and that is still right — what was wrong
   * is a track that cannot give anything back.
   * </p>
   *
   * <p>
   * Not a jsdom test, and not a class-name test: this is two boxes overlapping, which only
   * a browser with a layout can answer. It is also not a WIDTH problem — 320 px at 16 px
   * root is fine and 820 px at 32 px root is not — so no viewport breakpoint fixes it.
   * </p>
   */
  for (const size of [
    { label: "320 px at a 32 px root", width: 320, height: 640, root: 32 },
    { label: "820 px at a 32 px root", width: 820, height: 1180, root: 32 },
  ]) {
    test(`never paints a chip over a door's name at ${size.label}`, async ({ page }) => {
      await openDoors(page, [door({ name: "Side door" })]);
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate((px) => { document.documentElement.style.fontSize = `${px}px`; }, size.root);
      await page.waitForTimeout(400);

      const name = await page.getByRole("link", { name: "Side door" }).boundingBox();
      const chip = await page.getByText("Reporting", { exact: true }).boundingBox();
      const overlaps = !!name && !!chip
        && name.x < chip.x + chip.width && chip.x < name.x + name.width
        && name.y < chip.y + chip.height && chip.y < name.y + name.height;
      expect(overlaps).toBe(false);
      // And the card still holds the page inside the phone.
      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main")!;
        return { scroll: main.scrollWidth, client: main.clientWidth };
      });
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
    });
  }

  /**
   * <b>B14, which the first attempt at the overlap fix walked straight back into.</b>
   *
   * <p>
   * Letting the header wrap on demand put a two-chip card's chips on their own line and a
   * one-chip card's beside its name — three cards in a row laid out three ways, which is
   * the finding, verbatim. The chips have a row of their own on every card now, so this
   * measures what an admin scanning a row of cards actually relies on: the state chip is in
   * the same place relative to the card whatever is in it.
   * </p>
   */
  test("puts every card's chips in the same place, whatever each card carries", async ({ page }) => {
    await openDoors(page, [
      door({ name: "Alpha door", gate_key: "alpha" }),
      door({ id: OTHER_ID, name: "A", gate_key: null }),
      door({ id: "99999999-9999-9999-9999-99999999bbbb", name: "The changing room corridor door", gate_key: "corridor" }),
    ]);
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.waitForTimeout(400);

    const offsets: number[] = [];
    for (const name of ["Alpha door", "A", "The changing room corridor door"]) {
      const card = page.getByRole("article", { name, exact: true });
      const chip = await card.getByText(/Reporting|Needs a door name/).first().boundingBox();
      const box = await card.boundingBox();
      offsets.push(Math.round((chip?.y ?? 0) - (box?.y ?? 0)));
    }
    expect(offsets).toHaveLength(3);
    expect(new Set(offsets).size).toBe(1);
  });

  /**
   * <b>A8.</b> With the ADMIN's phone off the network every age went on ticking from a frozen
   * read, doors flipped one by one to "Not reporting", and the page asserted "nothing can
   * reach it" about boards that were, as far as anybody knew, fine.
   */
  test("stops claiming which doors are reporting once its own reads fail", async ({ page }) => {
    await openDoors(page, [door()]);
    await expect(page.getByText("Reporting")).toBeVisible();

    await page.route("**/api/v1/admin/doors", (route) => route.abort());
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.getByRole("button", { name: /Refresh|Checking/ }).click();

    await expect(page.getByText(/can't reach the club right now/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Not reporting")).toHaveCount(0);
  });
});

test.describe("One door's page, reachable with a thumb", () => {
  /**
   * <b>B6.</b> The door's controls were below a feed of up to fifty rows — 5 231 px down a
   * phone, measured. Somebody opens this page because something is wrong at a door, and the
   * thing they came to do was two full screens past the thing they came to read.
   */
  test("puts the controls above the scans and opens with ten of them", async ({ page }) => {
    const items = Array.from({ length: 24 }, (_, i) => ({
      at: ago(i * 60),
      action: "gate.opened",
      reason: "ok",
      offline: false,
      member: { id: "00000000-0000-0000-0000-0000000000aa", name: "Ada Lovelace" },
      fingerprint: "1f2e3d4c",
    }));
    // Replacing the base route rather than adding a second one at the same path: the stub
    // sorts by prefix length and keeps declaration order on a tie, so an override appended
    // after an identical path never wins and the feed arrives empty.
    await signIn(page);
    await serveApi(page, [
      ...routes([door()]).filter((r) => r.path !== `/api/v1/admin/devices/${DOOR_ID}/activity`),
      { path: `/api/v1/admin/devices/${DOOR_ID}/activity`, body: { items, events: [] } },
    ]);
    await page.goto(`/admin/doors/${DOOR_ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // At a PHONE width, which is where the 5 231 px was measured and the only width the
    // ordering is about: above `lg` the two columns put the controls beside the feed, at
    // the same y, and asserting an order there asserts the desktop layout is broken.
    await page.setViewportSize({ width: 390, height: 844 });
    const controls = await page.getByRole("heading", { name: "Shutting or removing this door" }).boundingBox();
    const scans = await page.getByRole("heading", { name: "Scans at this door" }).boundingBox();
    expect(controls?.y ?? 0).toBeLessThan(scans?.y ?? 0);

    const feed = page.getByRole("region", { name: "Scans at this door" });
    await expect(feed.getByRole("listitem")).toHaveCount(10);
    await feed.getByRole("button", { name: "Show the other 14 scans" }).click();
    await expect(feed.getByRole("listitem")).toHaveCount(24);
  });

  /**
   * <b>A5 / E-M6.</b> "You shut this door." was shown to every admin in the club — true of at
   * most one of them, and the screen never said which.
   */
  test("names who shut the door and when, rather than saying 'you'", async ({ page }) => {
    await openDoor(page, [door({
      enabled: false, shut_by_name: "Priya Naidoo", out_of_service_since: ago(600),
    })]);

    // The card's own notice and the control's standing Alert both name the actor — which
    // is the point — so this asserts the first rather than asserting there is only one.
    await expect(page.getByText(/Shut by Priya Naidoo/).first()).toBeVisible();
    await expect(page.getByText(/You shut this door/)).toHaveCount(0);
  });
});

/**
 * <b>A-L1 / C-L1 / B8 / R3-27 — the doors surface at a 32 px root font.</b>
 *
 * <p>
 * This surface is built to 44 px throughout because it is used standing up in a club with a
 * member waiting. Two things were not: the "Go to <door>" link in the attention summary, which
 * is the whole point of naming one door rather than counting three, measured 17 px; and the
 * club contact on a door's card, which is an email address with no break opportunity in it and
 * pushed the whole page sideways.
 * </p>
 */
test.describe("The doors pages at 320 px with a 32 px root font", () => {
  const large = async (page: Page) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    await page.waitForTimeout(400);
  };

  test("gives the summary's link to a door the same 44 px as everything else", async ({ page }) => {
    await openDoors(page, [door({ name: "Side door", enabled: false })]);
    await large(page);

    const link = page.getByRole("link", { name: "Go to Side door" });
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
  });

  test("does not let a club contact email push the door page sideways", async ({ page }) => {
    // The fixture sorts by prefix LENGTH and these are the same path, so declaration order
    // decides and the base route wins — the settings route is overridden in place instead.
    // The fixture sorts by prefix LENGTH and both entries are the same path, so declaration
    // order decides — an `extra` route for settings would lose to the base one. The whole
    // route list is built here instead.
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/admin/settings/", body: { ...SETTINGS, club_contact_email: "treasurer@crusaderssquashclub.co.za" } },
      ...routes([door()]).filter((r) => r.path !== "/api/v1/admin/settings/"),
    ]);
    await page.goto(`/admin/doors/${DOOR_ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await large(page);

    await expect(page.getByText(/treasurer@crusaderssquashclub/)).toBeVisible();
    const stuck = await page.evaluate(() => [...document.querySelectorAll("main *")]
      .filter((el) => {
        const e = el as HTMLElement;
        // The app shell's own rem-scaled padding is the chrome lane's — see the same
        // exclusion, with its measurement, in admin-devices.spec.ts.
        if (e.classList.contains("flex-1") && e.classList.contains("min-h-0")) return false;
        // `sr-only` is a 1 px clipped box by construction, so its content always "overflows"
        // it. That is what the utility is; it is not a layout fault.
        if (e.classList.contains("sr-only")) return false;
        return e.scrollWidth - e.clientWidth > 1 && e.getBoundingClientRect().width > 0;
      })
      .map((el) => ({
        over: (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth,
        cls: el.className?.toString().slice(0, 50) ?? "",
        text: (el.textContent ?? "").trim().slice(0, 40),
      })));
    expect(stuck, `boxes that cannot hold their content: ${JSON.stringify(stuck)}`).toEqual([]);
  });
});

/**
 * <b>R3-1 and R3-13, driven in a real browser.</b>
 *
 * <p>
 * Both are about what a screen ASSERTS when the thing it is asserting about cannot be seen —
 * a shut door whose age froze the moment it was shut, and a filter pointing at a board that
 * has been replaced. Both produced sentences a volunteer acts on, and neither is visible to a
 * test that cannot render a page.
 * </p>
 */
test.describe("What a door page claims about a shut it cannot see", () => {
  test("reports a confirmed shut as confirmed, though the door has gone quiet since", async ({ page }) => {
    const heardAt = new Date(Date.now() - 3600_000).toISOString();
    await openDoor(page, [door({
      name: "Front door",
      enabled: false,
      last_seen_at: heardAt,
      shut_heard_at: heardAt,
    })]);

    // Twice, and both are wanted: the state paragraph at the top of the page and the
    // clause beside the control an admin is about to press.
    await expect(page.getByText(/Confirmed: this door heard the shut at/).first()).toBeVisible();
    await expect(page.getByText(/Confirmed: this door heard the shut at/)).toHaveCount(2);
    // The three sentences a reviewer read over a board that had emptied its roster.
    await expect(page.getByText(/may still be admitting/)).toHaveCount(0);
    await expect(page.getByText(/Nothing can reach/)).toHaveCount(0);

    await page.getByRole("button", { name: /^Reopen this door/ }).click();
    await expect(page.getByText(/was told of the shut and has been opening for nobody/).first())
      .toBeVisible();
  });

  test("says it cannot tell where the server has not said", async ({ page }) => {
    await openDoor(page, [door({
      name: "Front door", enabled: false, last_seen_at: new Date(Date.now() - 3600_000).toISOString(),
    })]);

    await expect(page.getByText(/this page cannot say whether it was told/)).toBeVisible();
  });
});

test.describe("A club log filtered to a door that is gone", () => {
  test("says the door is gone rather than that nothing happened at any door", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      ...routes([door()]),
      {
        path: "/api/v1/admin/doors/activity",
        status: 400,
        body: { error: "door_not_found" },
      },
    ]);
    await page.goto("/admin/doors/log?door=11111111-2222-3333-4444-555555555555");

    await expect(page.getByText(/no longer on the club's list/)).toBeVisible();
    await expect(page.getByText("No scans at any door in the last 24 hours")).toHaveCount(0);
    // And the export that would have written a nought-row file under the ordinary name.
    await expect(page.getByRole("button", { name: "Download CSV" })).toHaveCount(0);
  });
});
