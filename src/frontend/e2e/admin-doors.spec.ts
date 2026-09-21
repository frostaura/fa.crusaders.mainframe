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
    await page.getByRole("button", { name: /tap again to confirm/ }).click();

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
    await page.getByRole("button", { name: /tap again to confirm/ }).click();

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

    const banner = page.getByRole("alert");
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
    await page.getByLabel("Name", { exact: true }).fill("Front door");
    await page.getByLabel("Door name", { exact: true }).fill("front-door");

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
    await page.getByLabel("Door name", { exact: true }).fill("   ");
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

    const notice = page.getByText(/^The club is not alerted about its silence/);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("can still reach the club hears that refusal and opens for nobody");
    await expect(notice).toContainText("has also lost the network never hears it");
    await expect(notice).toContainText("up to six hours");
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

  test("sends only enabled when a door is shut", async ({ page }) => {
    const only = door({ name: "Front door", gate_key: "front-door" });
    await openDoor(page, [only], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...only, enabled: false } },
    ]);

    const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/admin/devices/"));
    await page.getByRole("button", { name: "Shut this door — Front door" }).click();
    await page.getByRole("button", { name: "Shut this door — Front door — tap again to confirm" }).click();

    expect((await patch).postData()).toBe('{"enabled":false}');
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
    await expect(page.getByRole("button", { name: "Delete this door — Front door — tap again to confirm" })).toBeVisible();
    // The armed button IS the confirm sentence — asserted on the control rather than on a
    // text node, because the width sentinel carries the same words invisibly.
    const armed = page.getByRole("button", { name: "Delete this door — Front door — tap again to confirm" });
    await expect(armed).toBeVisible();
    // C10: the two facts the old sentence destroyed without ever mentioning them.
    await expect(armed).toContainText("what the lock does with no power");
    await expect(armed).toContainText("where the board is");
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

    await expect(page.getByLabel("Door")).toBeVisible();
    await expect(page.getByLabel("When")).toBeVisible();
    await expect(page.getByLabel("Outcome")).toBeVisible();
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
      const control = wrapper.locator("> button").first();
      // `innerText`, not `textContent`: the width sentinel inside the control is
      // visibility-hidden and carries a copy of BOTH labels, which textContent would hand back.
      const idleText = (await control.evaluate((el) => (el as HTMLElement).innerText)).trim();

      await control.click();
      // Armed: the wrapper now holds the control and its Cancel.
      await expect(wrapper.locator("> button")).toHaveCount(2);

      const measured = await control.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
        shown: (el as HTMLElement).innerText.trim(),
        pressed: el.getAttribute("aria-pressed"),
        name: el.getAttribute("aria-label"),
      }));

      expect(measured.shown, `confirm ${i} ("${idleText}") shows no consequence`).not.toBe(idleText);
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
      const cancel = wrapper.locator("> button").nth(1);
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
