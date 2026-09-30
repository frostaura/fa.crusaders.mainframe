import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminSettingsPage from "./AdminSettings";
import { SETTINGS_FIXTURE, refuse, renderPage, stubFetch, type StubRoute } from "../test/harness";
import { control, findControl, queryControl, querySaveButton, saveButton, sectionTrigger } from "../components/settings/testKit";
import { KINDS_FIXTURE, KINDS_ROUTE } from "../components/notifications/fixtures";
import { SETTINGS_COPY, SETTINGS_INTRO_KEY } from "../lib/settingsCopy";
import { EMAIL_ALERTS_COPY, lockedBecause } from "../lib/notificationsCopy";

/**
 * A longer per-test timeout than the 5-second default, for this file only. Each case drives
 * the whole settings page, every section and its save bar in jsdom — 1-2 s on a quiet machine,
 * past 5 s when the suite shares the machine with a parallel backend run or another build
 * (measured 2026-09-28: seven AdminSchedules cases timed out that way with nothing wrong).
 * The assertions are untouched; only the time allowed to render them is.
 */
vi.setConfig({ testTimeout: 20_000 });

/**
 * Settings → Admin alerts (R23: "all admins must receive emails for things like new member
 * requests").
 *
 * <p>
 * Two halves that behave differently on purpose, and most of these tests hold them apart: the
 * club's thresholds are settings — they ride the save bar, are refused in bounds before the wire,
 * and are sent snake_case because that is the ONLY spelling the API binds for them (a camelCase
 * key is answered {"saved": true} and changes nothing) — and the admin's own inbox switches are a
 * preference that saves the moment it is flipped and never appears in the change count.
 * </p>
 */

const ALERT_KEYS = {
  fault_spike_count: 5, fault_spike_minutes: 15, application_reminder_hours: 24, admin_notification_retention_days: 90,
};

function routes(over: Record<string, unknown> = {}, extra: StubRoute[] = []): StubRoute[] {
  // `extra` FIRST: on a tie of path length the stub answers with the route declared first, so a
  // test's own refusal wins over the default success.
  return [
    ...extra,
    { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...ALERT_KEYS, ...over } },
    { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
    KINDS_ROUTE,
  ];
}

async function openAlerts() {
  fireEvent.click(await screen.findByRole("button", { name: "Admin alerts" }));
  return screen.getByRole("region", { name: "Admin alerts" });
}

const lastPut = (stub: ReturnType<typeof stubFetch>, path: string) =>
  [...stub.calls].reverse().find((call) => call.method === "PUT" && call.path.startsWith(path));

beforeEach(() => window.localStorage.setItem(SETTINGS_INTRO_KEY, "1"));
afterEach(() => { vi.unstubAllGlobals(); window.localStorage.removeItem(SETTINGS_INTRO_KEY); });

describe("Settings → Admin alerts: the club's thresholds", () => {
  it("shows the four numbers the API serves, at what it serves", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    const section = await openAlerts();

    expect(control(/Remind about waiting applications after/)).toHaveValue(24);
    expect(control("Fault spike (faults)")).toHaveValue(5);
    expect(control(/Fault spike window/)).toHaveValue(15);
    // Retention is rarely touched: behind the section's advanced disclosure.
    fireEvent.click(within(section).getByRole("button", { name: SETTINGS_COPY.advancedShow(1) }));
    expect(control(/Keep alerts on the Overview for/)).toHaveValue(90);
    // The visible line carries the server's bound.
    expect(within(section).getByText(/Allowed: 2–100 faults/)).toBeInTheDocument();
  });

  it("summarises the section in one line while it is closed", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByRole("button", { name: "Admin alerts" })).toHaveAccessibleDescription(
      "Applications chased after 24 hours · 5 faults in 15 min is a spike · alerts kept 90 days",
    );
  });

  it("refuses a spike count below 2 on the field, before anything reaches the API", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    await openAlerts();

    fireEvent.change(control("Fault spike (faults)"), { target: { value: "1" } });
    fireEvent.click(saveButton());

    expect((await screen.findAllByText("Fault spike (faults) has to be a whole number from 2 to 100.")).length)
      .toBeGreaterThanOrEqual(1);
    expect(stub.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("saves them snake_case — the only spelling the API binds for them", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    await openAlerts();

    fireEvent.change(control("Fault spike (faults)"), { target: { value: "8" } });
    fireEvent.change(control(/Remind about waiting applications after/), { target: { value: "12" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(lastPut(stub, "/api/v1/admin/settings/")).toBeTruthy());
    const put = lastPut(stub, "/api/v1/admin/settings/")!;
    expect(put.body).toEqual(expect.objectContaining({
      fault_spike_count: 8, application_reminder_hours: 12, fault_spike_minutes: 15, admin_notification_retention_days: 90,
    }));
    // A camelCase twin would be bound by nothing: {"saved": true} and no change.
    expect(put.raw).not.toMatch(/faultSpikeCount|applicationReminderHours/);
    // And the older keys go on as they always have.
    expect(put.body).toEqual(expect.objectContaining({ sliceMinutes: 15, creditsPerZarRegular: 1.6, slicePriceCredits: 8 }));
  });

  it("an API without the thresholds gets no rows and no complaint — and the admin still has their switches", async () => {
    const stub = stubFetch([
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
      KINDS_ROUTE,
    ]);
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByRole("button", { name: "Admin alerts" })).toHaveAccessibleDescription("Which alerts reach your inbox");
    const section = await openAlerts();
    expect(queryControl("Fault spike (faults)")).toBeNull();
    expect(within(section).getByText(SETTINGS_COPY.notServed)).toBeInTheDocument();
    expect(await within(section).findByRole("switch", { name: KINDS_FIXTURE[0].title })).toBeInTheDocument();

    // Saving something else sends none of the four at all — absent means unchanged.
    fireEvent.change(await findControl(/Unlock time/), { target: { value: "16" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(lastPut(stub, "/api/v1/admin/settings/")).toBeTruthy());
    expect(lastPut(stub, "/api/v1/admin/settings/")!.raw).not.toMatch(/fault_spike|application_reminder|admin_notification/);
  });

  it("is found by searching for what it does", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByRole("searchbox", { name: SETTINGS_COPY.searchLabel }), { target: { value: "email" } });
    expect(await screen.findByRole("region", { name: "Admin alerts" })).toBeVisible();
  });
});

describe("Settings → Admin alerts: the notifier's quiet times", () => {
  const COOLDOWNS = { topup_failure_cooldown_minutes: 30, overdraft_cooldown_minutes: 15 };

  it("shows the two cooldowns the API serves, with the server's own bounds", async () => {
    stubFetch(routes(COOLDOWNS));
    renderPage(<AdminSettingsPage />);
    const section = await openAlerts();

    expect(control("Top-up failure emails — quiet time (minutes)")).toHaveValue(30);
    expect(control("Below-zero booking emails — quiet time (minutes)")).toHaveValue(15);
    expect(within(section).getByText(/Allowed: 5–1440 min/)).toBeInTheDocument();
    expect(within(section).getByText(/Allowed: 1–240 min/)).toBeInTheDocument();
    // The board cooldown keeps its own row under Court boxes, not a second one here.
    expect(screen.queryAllByLabelText(/Alert cooldown/, { selector: "input" })).toHaveLength(1);
  });

  it("draws a row for a *_cooldown_minutes key the console has never heard of, in words made from its key", async () => {
    stubFetch(routes({ ...COOLDOWNS, widget_jam_cooldown_minutes: 10 }));
    renderPage(<AdminSettingsPage />);
    await openAlerts();

    expect(control(/Quiet time between “widget jam” emails/)).toHaveValue(10);
  });

  it("counts an edit to one as a change and sends it back snake_case", async () => {
    const stub = stubFetch(routes(COOLDOWNS));
    renderPage(<AdminSettingsPage />);
    await openAlerts();

    fireEvent.change(control("Top-up failure emails — quiet time (minutes)"), { target: { value: "45" } });
    fireEvent.change(control("Below-zero booking emails — quiet time (minutes)"), { target: { value: "5" } });
    expect(screen.getByText(SETTINGS_COPY.changes(2))).toBeInTheDocument();
    fireEvent.click(saveButton());

    await waitFor(() => expect(lastPut(stub, "/api/v1/admin/settings/")).toBeTruthy());
    const put = lastPut(stub, "/api/v1/admin/settings/")!;
    expect(put.body).toEqual(expect.objectContaining({ topup_failure_cooldown_minutes: 45, overdraft_cooldown_minutes: 5 }));
    expect(put.raw).not.toMatch(/topupFailureCooldownMinutes|overdraftCooldownMinutes/);
  });

  it("refuses zero on the field — neither can be turned into an email per event", async () => {
    const stub = stubFetch(routes(COOLDOWNS));
    renderPage(<AdminSettingsPage />);
    await openAlerts();

    fireEvent.change(control("Top-up failure emails — quiet time (minutes)"), { target: { value: "0" } });
    fireEvent.click(saveButton());
    expect((await screen.findAllByText(
      "Top-up failure emails — quiet time (minutes) has to be a whole number from 5 to 1440.",
    )).length).toBeGreaterThanOrEqual(1);
    expect(stub.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("an emptied cooldown is not zero: it blocks the save like any other number", async () => {
    const stub = stubFetch(routes(COOLDOWNS));
    renderPage(<AdminSettingsPage />);
    await openAlerts();

    fireEvent.change(control("Below-zero booking emails — quiet time (minutes)"), { target: { value: "" } });
    fireEvent.click(saveButton());
    expect((await screen.findAllByText(/Below-zero booking emails — quiet time \(minutes\) needs a number/)).length)
      .toBeGreaterThanOrEqual(1);
    expect(stub.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("for an unknown cooldown the server's bound is the only one — and its refusal names the field", async () => {
    stubFetch(routes({ widget_jam_cooldown_minutes: 10 }, [
      { method: "PUT", path: "/api/v1/admin/settings/", status: 400, body: { error: "widget_jam_cooldown_minutes_out_of_range" } },
    ]));
    renderPage(<AdminSettingsPage />);
    await openAlerts();

    fireEvent.change(control(/Quiet time between “widget jam” emails/), { target: { value: "99999" } });
    fireEvent.click(saveButton());

    expect(await screen.findByText(
      "Quiet time between “widget jam” emails (minutes) is outside what the club’s system accepts. Nothing was saved.",
    )).toBeInTheDocument();
  });
});

describe("Settings → Admin alerts: your email alerts", () => {
  it("lists every kind from the catalogue, on or off as this admin left it", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    const section = await openAlerts();
    const panel = within(section).getByRole("region", { name: EMAIL_ALERTS_COPY.settingsTitle });

    expect(await within(panel).findByRole("switch", { name: "New membership applications" })).toBeChecked();
    expect(within(panel).getByRole("switch", { name: "Court box or door stopped reporting" })).not.toBeChecked();
    expect(within(panel).getByText(EMAIL_ALERTS_COPY.description)).toBeInTheDocument();
  });

  it("shows the kinds nobody may switch off as locked on, with why beside the lock", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    const section = await openAlerts();

    const locked = await within(section).findByRole("switch", { name: "Administrator changes" });
    expect(locked).toBeChecked();
    expect(locked).toHaveAttribute("aria-disabled", "true");
    expect(locked).toHaveAccessibleDescription(expect.stringContaining(lockedBecause("admin.role_changed")));
    fireEvent.click(locked);
    expect(locked).toBeChecked();
  });

  it("saves a flip at once, as the WHOLE opt-out list, without touching the save bar", async () => {
    const stub = stubFetch(routes({}, [{ method: "PUT", path: "/api/v1/me/preferences", body: { admin_notification_optouts: [] } }]));
    renderPage(<AdminSettingsPage />);
    const section = await openAlerts();

    fireEvent.click(await within(section).findByRole("switch", { name: "New membership applications" }));

    await waitFor(() => expect(lastPut(stub, "/api/v1/me/preferences")).toBeTruthy());
    // device.offline was already off and stays off; the security kinds are never listed.
    expect(lastPut(stub, "/api/v1/me/preferences")!.body).toEqual({ admin_notification_optouts: ["member.registered", "device.offline"] });
    expect(await screen.findByText(EMAIL_ALERTS_COPY.switchedOff("New membership applications"))).toBeInTheDocument();
    expect(within(section).getByRole("switch", { name: "New membership applications" })).not.toBeChecked();
    // A preference, not a club setting: nothing for "Save changes" to count.
    expect(querySaveButton()).toBeNull();
    expect(stub.calls.some((call) => call.method === "PUT" && call.path.startsWith("/api/v1/admin/settings"))).toBe(false);
  });

  /** Review round 1, F3.11: switching an alert off said nothing about who else is told. */
  it("warns at the switch when switching it off leaves nobody emailed", async () => {
    const kinds = KINDS_FIXTURE.map((k) => (k.kind === "member.registered" ? { ...k, others_receiving: 0 } : k));
    stubFetch(routes({}, [
      { path: "/api/v1/admin/notifications/kinds", body: { kinds } },
      { method: "PUT", path: "/api/v1/me/preferences", body: { admin_notification_optouts: [] } },
    ]));
    renderPage(<AdminSettingsPage />);
    const section = await openAlerts();
    expect(within(section).queryByText(EMAIL_ALERTS_COPY.nobodyTold)).toBeNull();

    fireEvent.click(await within(section).findByRole("switch", { name: "New membership applications" }));
    const row = section.querySelector("[data-alert-kind='member.registered']") as HTMLElement;
    expect(await within(row).findByText(EMAIL_ALERTS_COPY.nobodyTold)).toBeInTheDocument();
  });

  it("says what it cannot know when the server does not say who else is told", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    const section = await openAlerts();
    // device.offline is already off in the fixture, with no count from the server.
    await within(section).findByRole("switch", { name: "Court box or door stopped reporting" });
    const row = section.querySelector("[data-alert-kind='device.offline']") as HTMLElement;
    expect(within(row).getByText(EMAIL_ALERTS_COPY.othersUnknown)).toBeInTheDocument();
  });

  it("puts a refused flip back, says nothing changed, and re-reads what the server holds", async () => {
    const stub = stubFetch(routes({}, [
      { method: "PUT", path: "/api/v1/me/preferences", respond: () => refuse(503, { error: "upstream_unavailable" }) },
    ]));
    renderPage(<AdminSettingsPage />);
    const section = await openAlerts();

    const toggle = await within(section).findByRole("switch", { name: "Court box or door stopped reporting" });
    fireEvent.click(toggle);

    expect(await screen.findByText(/Couldn’t change the court box or door stopped reporting email|Couldn't change the court box/)).toBeInTheDocument();
    await waitFor(() => expect(within(section).getByRole("switch", { name: "Court box or door stopped reporting" })).not.toBeChecked());
    await waitFor(() => expect(stub.calls.filter((call) => call.path.startsWith(KINDS_ROUTE.path))).toHaveLength(2));
  });

  it("a failed read of the catalogue says so, with a retry — never an empty list", async () => {
    stubFetch(routes({}, [
      // `body` present for the harness's own check; `sequence` is what answers.
      { path: "/api/v1/admin/notifications/kinds", status: [429, 200], body: null, sequence: [{ error: "rate_limited" }, { kinds: KINDS_FIXTURE }] },
    ]));
    renderPage(<AdminSettingsPage />);
    const section = await openAlerts();

    // A refusal that can pass (429 — a 5xx is a deployment fault, which drops the retry by design).
    expect(await within(section).findByText(/Too many requests right now/)).toBeInTheDocument();
    expect(within(section).queryByRole("switch")).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: /Try again/ }));
    expect(await within(section).findByRole("switch", { name: "New membership applications" })).toBeInTheDocument();
  });
});

describe("Settings → the league rate after D2", () => {
  it("says where the league rate went when an older screen's save is refused for it", async () => {
    stubFetch(routes({}, [
      { method: "PUT", path: "/api/v1/admin/settings/", status: 400, body: { error: "credits_per_zar_league_moved_to_groups" } },
    ]));
    renderPage(<AdminSettingsPage />);
    fireEvent.change(await findControl(/Unlock time/), { target: { value: "16" } });
    fireEvent.click(saveButton());

    expect(await screen.findByText(/The league rate lives on the League group now/)).toBeInTheDocument();
  });

  it("keeps the section's own words free of classes", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Credits & top-ups" }));
    const credits = screen.getByRole("region", { name: "Credits & top-ups" });
    expect(credits).not.toHaveTextContent(/over-65|their class/);
    expect(sectionTrigger("Credits & top-ups")).toHaveAccessibleDescription(/R1 buys 1.6 cr unless a group says otherwise/);
  });
});
