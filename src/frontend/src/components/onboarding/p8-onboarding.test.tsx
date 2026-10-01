import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import GetStartedPage from "../../pages/GetStarted";
import { ProfileProvider } from "../../lib/profile";
import { ONBOARDING_STORAGE_KEY, SIGNED_IN_ARRIVAL, type OnboardingPrefs } from "../../lib/onboarding";
import { ADMIN_TOUR, CHECKLIST, GET_STARTED } from "../../lib/onboardingCopy";
import { PRIVACY_COPY } from "../../lib/playersCopy";
import { refuse, renderPage, signIn, signOut, stubFetch, type StubRoute } from "../../test/harness";
import { AdminTour } from "./AdminTour";
import { tourStops } from "./adminTourMarks";
import { ADMIN_NAV_ITEMS } from "../admin/adminNav";
import { CoachMarks } from "./CoachMarks";
import { FirstRunGate } from "./FirstRunGate";
import { SetupChecklist } from "./SetupChecklist";
import { resetOnboardingStore } from "./useOnboarding";

/**
 * P8 — the welcome wizard, the first-run gate, the setup checklist and the admin tour, driven
 * through the house providers with the API stubbed. Everything is found by the words in
 * `lib/onboardingCopy.ts`, so a rewording is one edit and never a hunt through selectors.
 */

const PREFS: OnboardingPrefs = {
  member_onboarding_completed_at: null,
  member_onboarding_dismissed_at: null,
  member_onboarding_last_step: null,
  admin_onboarding_completed_at: null,
  onboarding_version: 1,
  current_onboarding_version: 1,
};

type Setup = { admin?: boolean; status?: string | null; prefs?: Partial<OnboardingPrefs> | null; extra?: StubRoute[] };

function api({ admin = false, status = "active", prefs = PREFS, extra = [] }: Setup = {}) {
  const whoami = signIn({ isAdmin: admin });
  const profile: Record<string, unknown> = {
    user_id: whoami.user_id, email: "thandi@review.test", is_admin: admin, tenant_slug: "crusaders",
    full_name: "Thandi Probe", membership_number: "M-9", photo_url: null, status,
  };
  if (prefs) profile.preferences = { ...PREFS, ...prefs };
  // `extra` first: the stub picks the longest prefix and, between equals, the first declared.
  const stub = stubFetch([
    ...extra,
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/me/profile", body: profile },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    // P11 — the privacy step reads the social half of the preferences.
    { path: "/api/v1/me/preferences", body: { ...PREFS, findable: false, show_in_leaderboards: false } },
    { method: "PUT", path: "/api/v1/me/preferences", respond: (r) => ({ ...PREFS, findable: false, show_in_leaderboards: false, ...(r.body as object) }) },
    { method: "PUT", path: "/api/v1/me/onboarding/member/step", respond: (r) => ({ ...PREFS, member_onboarding_last_step: (r.body as { step: string }).step }) },
    { method: "POST", path: "/api/v1/me/onboarding/member/complete", body: { ...PREFS, member_onboarding_completed_at: "2026-09-23T10:00:00Z" } },
    { method: "POST", path: "/api/v1/me/onboarding/member/dismiss", body: { ...PREFS, member_onboarding_dismissed_at: "2026-09-23T10:00:00Z" } },
    { method: "POST", path: "/api/v1/me/onboarding/admin/complete", body: { ...PREFS, admin_onboarding_completed_at: "2026-09-23T10:00:00Z" } },
  ]);
  return { stub, userId: whoami.user_id };
}

function withProfile(children: ReactNode, entry: string) {
  return renderPage(<ProfileProvider>{children}</ProfileProvider>, { initialEntries: [entry] });
}

function wizardAt(entry = "/get-started") {
  return withProfile(
    <Routes>
      <Route path="/get-started" element={<GetStartedPage />} />
      <Route path="/my-code" element={<p>My code landing</p>} />
    </Routes>,
    entry,
  );
}

beforeEach(() => {
  resetOnboardingStore();
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  signOut();
});

describe("the welcome wizard", () => {
  it("walks forward and back through the steps, saying where it is", async () => {
    api();
    wizardAt();
    expect(await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.welcome.title })).toBeInTheDocument();
    expect(screen.getByText(GET_STARTED.stepOf(1, 7))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: GET_STARTED.back })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: GET_STARTED.next }));
    const code = await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.code.title });
    // Focus follows the step, because the route did not change and nothing else would move it.
    await waitFor(() => expect(code).toHaveFocus());
    expect(screen.getByText(GET_STARTED.stepOf(2, 7))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: GET_STARTED.steps.code.link })).toHaveAttribute("href", "/my-code");

    fireEvent.click(screen.getByRole("button", { name: GET_STARTED.back }));
    expect(await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.welcome.title })).toBeInTheDocument();
  });

  it("records each step reached as the resume point, and never the one it opened at", async () => {
    const { stub, userId } = api();
    wizardAt();
    await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.welcome.title });
    expect(stub.calls.some((c) => c.path === "/api/v1/me/onboarding/member/step")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: GET_STARTED.next }));
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT" && c.path === "/api/v1/me/onboarding/member/step")?.body)
      .toEqual({ step: "code" }));
    expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)[userId].lastStep).toBe("code");
  });

  it("resumes where this device left off", async () => {
    const { userId } = api();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ [userId]: { lastStep: "buy" } }));
    wizardAt();
    expect(await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.buy.title })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: GET_STARTED.steps.buy.cta })).toHaveAttribute("href", "/wallet/buy");
  });

  /**
   * P13 — the "top up" step became "buy minutes". A phone (or the server) whose resume point is
   * the old id must land on the step that replaced it, and the step must say what the club sells
   * now: minutes, a booking costing its playing time — never credit, never a top-up.
   */
  it("opens the buy-minutes step for a resume point stored as the old top-up step, in minutes words", async () => {
    const { userId } = api({ prefs: { member_onboarding_last_step: "topup" } });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ [userId]: { lastStep: "topup" } }));
    wizardAt();
    expect(await screen.findByRole("heading", { level: 2, name: "Buy minutes" })).toBeInTheDocument();
    const step = screen.getByRole("region", { name: "Buy minutes" });
    expect(step).toHaveTextContent(/a booking costs exactly its playing time/);
    expect(step.textContent).not.toMatch(/credit|top.?up|\bcr\b/i);
    expect(screen.getByRole("link", { name: "Buy minutes" })).toHaveAttribute("href", "/wallet/buy");
  });

  it("resumes where the server says, when this device has nothing", async () => {
    api({ prefs: { member_onboarding_last_step: "book" } });
    wizardAt();
    expect(await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.book.title })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: GET_STARTED.steps.book.cta })).toHaveAttribute("href", "/bookings");
  });

  it("starts from the beginning on a replay, whatever the resume point", async () => {
    api({ prefs: { member_onboarding_last_step: "book", member_onboarding_completed_at: "2026-09-01T10:00:00Z" } });
    wizardAt("/get-started?replay=1");
    expect(await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.welcome.title })).toBeInTheDocument();
  });

  it("finishes on the last step: the club is told, and the member lands on My Code", async () => {
    const { stub } = api();
    wizardAt("/get-started?step=privacy");
    fireEvent.click(await screen.findByRole("button", { name: GET_STARTED.finish }));
    expect(await screen.findByText("My code landing")).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST" && c.path === "/api/v1/me/onboarding/member/complete")).toBe(true);
  });

  it("can be skipped from any step, and a skip is recorded as a dismissal", async () => {
    const { stub, userId } = api();
    wizardAt("/get-started?step=passkey");
    fireEvent.click(await screen.findByRole("button", { name: GET_STARTED.skip }));
    expect(await screen.findByText("My code landing")).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST" && c.path === "/api/v1/me/onboarding/member/dismiss")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)[userId].memberDismissedAt).toBeTruthy();
  });

  it("still lets a member finish when the club cannot be reached, and says it is remembered here", async () => {
    const { userId } = api({ extra: [{ method: "POST", path: "/api/v1/me/onboarding/member/complete", body: refuse(503, { error: "down" }) }] });
    wizardAt("/get-started?step=privacy");
    fireEvent.click(await screen.findByRole("button", { name: GET_STARTED.finish }));
    expect(await screen.findByText("My code landing")).toBeInTheDocument();
    expect(await screen.findByText(GET_STARTED.savedHereOnly)).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)[userId].memberDoneVersion).toBe(1);
  });

});

describe("the welcome wizard's steps", () => {
  it("never claims the court box reads fingerprints — an old link to that step opens the welcome", async () => {
    // Dean, 2026-10-01: the court box does not read fingerprints yet. A passkey's fingerprint is
    // the phone's own unlock for signing in to this app, and the passkey step says so.
    api();
    wizardAt("/get-started?step=fingerprint");
    expect(await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.welcome.title })).toBeInTheDocument();
    expect(screen.queryByText(/court box can also recognise a fingerprint/i)).toBeNull();
    expect(screen.getByText(GET_STARTED.stepOf(1, 7))).toBeInTheDocument();
  });

  it("says a passkey is for signing in to this app, and the code is what works at the club", async () => {
    api();
    wizardAt("/get-started?step=passkey");
    const step = (await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.passkey.title })).closest("section")!;
    expect(step).toHaveTextContent(/signing in to this app/i);
    expect(step).toHaveTextContent(/your code is what opens the door/i);
  });

  it("says so plainly when this browser cannot make a passkey", async () => {
    api();
    wizardAt("/get-started?step=passkey");
    expect(await screen.findByText(GET_STARTED.steps.passkey.unsupported)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: GET_STARTED.steps.passkey.add })).toBeNull();
  });

  it("says where the club's messages arrive, without promising push notifications", async () => {
    api();
    wizardAt("/get-started?step=install");
    expect(await screen.findByText(GET_STARTED.steps.install.email)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/push notification/i);
  });
});

describe("the first-run gate", () => {
  /**
   * `/signed-in` stands for a sign-in's own navigation: it lands on My Code carrying the router
   * state Login sends (F4.8). A bare `/my-code` entry is the member opening it at the door.
   */
  function gateAt(entry: string) {
    return withProfile(
      <>
        <FirstRunGate />
        <Routes>
          <Route path="/signed-in" element={<Navigate to="/my-code" replace state={SIGNED_IN_ARRIVAL} />} />
          <Route path="/my-code" element={<p>My code landing</p>} />
          <Route path="/bookings" element={<p>Bookings page</p>} />
          <Route path="/get-started" element={<p>Wizard page</p>} />
        </Routes>
      </>,
      entry,
    );
  }

  it("sends a newly approved member from the landing to the wizard, straight after signing in", async () => {
    api();
    gateAt("/signed-in");
    expect(await screen.findByText("Wizard page")).toBeInTheDocument();
  });

  it("does it once per tab, not on every arrival at the landing", async () => {
    const { userId } = api();
    window.sessionStorage.setItem("crusaders.onboarding.offered", userId);
    gateAt("/signed-in");
    await waitFor(() => expect(screen.getByText("My code landing")).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("Wizard page")).toBeNull();
  });

  it.each([
    ["a member who finished it", { prefs: { member_onboarding_completed_at: "2026-09-01T10:00:00Z" } }, "/signed-in"],
    ["a member who dismissed it", { prefs: { member_onboarding_dismissed_at: "2026-09-01T10:00:00Z" } }, "/signed-in"],
    ["an API that sends no preferences", { prefs: null }, "/signed-in"],
    ["an account with no membership", { status: null }, "/signed-in"],
    // F4.8 — the wizard owed, and My Code opened directly: the app's start URL, at a door.
    ["a member who opened My Code at the door", {}, "/my-code"],
    ["a member who opened another page", {}, "/bookings"],
  ] as const)("leaves %s where they are", async (_why, setup, entry) => {
    const { stub } = api(setup as Setup);
    gateAt(entry);
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/me/profile")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("Wizard page")).toBeNull();
  });
});

describe("the setup checklist", () => {
  it("shows the four things with what is done counted, each a link to where it is done", async () => {
    api({
      extra: [
        { path: "/api/v1/me/webauthn/credentials", body: [{ id: "p", label: "iPhone", transports: null, created_at: "2026-09-01T10:00:00Z", last_used_at: null }] },
      ],
    });
    withProfile(<SetupChecklist />, "/my-code");
    const card = await screen.findByRole("region", { name: CHECKLIST.title });
    await within(card).findByText(CHECKLIST.progress(1, 4));
    expect(within(card).getByRole("link", { name: CHECKLIST.items.passkey.done })).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: CHECKLIST.items.buy.label })).toHaveAttribute("href", "/wallet/buy");
    // P13: the step is buying minutes (a package), never "top up" — and nothing on the card says credit.
    expect(CHECKLIST.items.buy.label).toBe("Buy minutes");
    expect(card.textContent).not.toMatch(/credit|top.?up/i);
    expect(within(card).getByRole("link", { name: CHECKLIST.items.booking.label })).toHaveAttribute("href", "/bookings");
    expect(within(card).getByRole("link", { name: CHECKLIST.resume })).toHaveAttribute("href", "/get-started");
  });

  it("says it could not check, rather than 'not done', when a read fails", async () => {
    api({ extra: [{ path: "/api/v1/me/webauthn/credentials", body: refuse(500, { error: "boom" }) }] });
    withProfile(<SetupChecklist />, "/my-code");
    const card = await screen.findByRole("region", { name: CHECKLIST.title });
    const row = await within(card).findByRole("link", { name: new RegExp(CHECKLIST.items.passkey.label) });
    expect(row).toHaveTextContent(CHECKLIST.unknown);
  });

  it("can be hidden, and stays hidden on this device", async () => {
    api();
    const first = withProfile(<SetupChecklist />, "/my-code");
    const card = await screen.findByRole("region", { name: CHECKLIST.title });
    fireEvent.click(within(card).getByRole("button", { name: CHECKLIST.hide }));
    await waitFor(() => expect(screen.queryByRole("region", { name: CHECKLIST.title })).toBeNull());
    first.unmount();

    withProfile(<SetupChecklist />, "/my-code");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region", { name: CHECKLIST.title })).toBeNull();
  });

  it("goes away by itself once everything is done", async () => {
    const { stub } = api({
      extra: [
        { path: "/api/v1/me/webauthn/credentials", body: [{ id: "p", label: "iPhone", transports: null, created_at: "2026-09-01T10:00:00Z", last_used_at: null }] },
        { path: "/api/v1/wallet", body: { balance_minutes: 40, entries: [{ id: "1", type: "BookingCharge" }], total_entries: 1, offset: 0, limit: 50 } },
      ],
    });
    const { userId } = { userId: "44444444-4444-4444-4444-444444444444" };
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ [userId]: { installed: true } }));
    withProfile(<SetupChecklist />, "/my-code");
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith("/api/v1/wallet?"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region", { name: CHECKLIST.title })).toBeNull();
  });

  it("is not shown to an account with no active membership", async () => {
    const { stub } = api({ status: null });
    withProfile(<SetupChecklist />, "/my-code");
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/me/profile")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region", { name: CHECKLIST.title })).toBeNull();
  });
});

describe("coach marks", () => {
  const marks = [
    { id: "a", title: "First stop", body: "The first thing.", anchor: () => null },
    { id: "b", title: "Second stop", body: "The second thing.", anchor: () => null, hint: "Look up." },
  ];

  it("shows one mark at a time, with its place in the tour, and moves both ways", async () => {
    const onFinish = vi.fn();
    renderPage(<CoachMarks marks={marks} labels={ADMIN_TOUR} onFinish={onFinish} />);
    const first = await screen.findByRole("dialog", { name: "First stop" });
    expect(first).toHaveTextContent(ADMIN_TOUR.stepOf(1, 2));
    expect(first).toHaveTextContent("The first thing.");

    fireEvent.click(within(first).getByRole("button", { name: ADMIN_TOUR.next }));
    const second = await screen.findByRole("dialog", { name: "Second stop" });
    expect(second).toHaveTextContent("Look up.");
    fireEvent.click(within(second).getByRole("button", { name: ADMIN_TOUR.back }));
    await screen.findByRole("dialog", { name: "First stop" });
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("finishes as done on the last mark, and as skipped by the words, the × or Escape", async () => {
    const onFinish = vi.fn();
    renderPage(<CoachMarks marks={marks} labels={ADMIN_TOUR} onFinish={onFinish} />);
    let dialog = await screen.findByRole("dialog", { name: "First stop" });
    fireEvent.click(within(dialog).getByRole("button", { name: ADMIN_TOUR.skip }));
    fireEvent.click(within(dialog).getByRole("button", { name: ADMIN_TOUR.close }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onFinish.mock.calls.map((c) => c[0])).toEqual(["skipped", "skipped", "skipped"]);

    fireEvent.click(within(dialog).getByRole("button", { name: ADMIN_TOUR.next }));
    dialog = await screen.findByRole("dialog", { name: "Second stop" });
    fireEvent.click(within(dialog).getByRole("button", { name: ADMIN_TOUR.done }));
    expect(onFinish).toHaveBeenLastCalledWith("done");
  });
});

describe("the admin tour", () => {
  function tourAt(entry: string) {
    return withProfile(
      <Routes>
        <Route path="/admin" element={<><p>Overview page</p><AdminTour /></>} />
        <Route path="/admin/members" element={<><p>Members page</p><AdminTour /></>} />
      </Routes>,
      entry,
    );
  }

  it("fires on the first visit to the Admin tab and covers every section the console has", async () => {
    api({ admin: true });
    tourAt("/admin");
    const stops = tourStops();
    const first = await screen.findByRole("dialog", { name: ADMIN_TOUR.stops[0].title });
    expect(first).toHaveTextContent(ADMIN_TOUR.stepOf(1, stops.length));
    // Every stop names a section of the console; Packages (P13) only once the console has it.
    const nav = new Set(ADMIN_NAV_ITEMS.map((item) => item.id));
    expect(stops.every((stop) => nav.has(stop.navId))).toBe(true);
    expect(stops.map((s) => s.title)).toEqual(
      ["Overview", "Members", "Groups", "Packages", "Transactions", "Control board", "Settings"].filter((t) => t !== "Packages" || nav.has("packages")),
    );
  });

  it("joins the Packages stop to the tour once the console has the page, and never anchors a stop to nothing", () => {
    const without = tourStops(new Set(["overview", "members", "groups", "transactions", "control-board", "settings"]));
    expect(without.map((s) => s.navId)).not.toContain("packages");
    const withPackages = tourStops(new Set(["overview", "members", "groups", "packages", "transactions", "control-board", "settings"]));
    expect(withPackages.map((s) => s.navId)).toEqual(["overview", "members", "groups", "packages", "transactions", "control-board", "settings"]);
    // P13: the tour speaks minutes and packages, never credit or a top-up rate.
    const words = ADMIN_TOUR.stops.map((s) => s.body).join(" ");
    expect(words).not.toMatch(/credit|top.?up/i);
    expect(words).toMatch(/package/);
  });

  it("is recorded as finished when skipped, and does not come back", async () => {
    const { stub } = api({ admin: true });
    tourAt("/admin");
    const first = await screen.findByRole("dialog", { name: ADMIN_TOUR.stops[0].title });
    fireEvent.click(within(first).getByRole("button", { name: ADMIN_TOUR.skip }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path === "/api/v1/me/onboarding/admin/complete")).toBe(true));
  });

  it("never fires on a page an admin deep-linked to", async () => {
    const { stub } = api({ admin: true });
    tourAt("/admin/members");
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/me/profile")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays away once completed, and returns on a replay", async () => {
    api({ admin: true, prefs: { admin_onboarding_completed_at: "2026-09-01T10:00:00Z" } });
    const view = tourAt("/admin");
    await screen.findByText("Overview page");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
    view.unmount();

    api({ admin: true, prefs: { admin_onboarding_completed_at: "2026-09-01T10:00:00Z" } });
    tourAt("/admin?tour=replay");
    expect(await screen.findByRole("dialog", { name: ADMIN_TOUR.stops[0].title })).toBeInTheDocument();
  });
});

describe("the welcome wizard's privacy step (P11, D13)", () => {
  it("ends on the privacy choice (P11, D13): both switches off, and a flip is saved", async () => {
    const { stub } = api();
    wizardAt("/get-started?step=install");
    await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.install.title });
    fireEvent.click(screen.getByRole("button", { name: GET_STARTED.next }));
    expect(await screen.findByRole("heading", { level: 2, name: GET_STARTED.steps.privacy.title })).toBeInTheDocument();
    expect(screen.getByText(GET_STARTED.stepOf(7, 7))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: GET_STARTED.finish })).toBeInTheDocument();

    const findable = await screen.findByRole("switch", { name: PRIVACY_COPY.findableLabel });
    expect(findable).toHaveAttribute("aria-checked", "false");
    // Leaderboards do not exist yet, so neither does their switch.
    expect(screen.queryByRole("switch", { name: PRIVACY_COPY.leaderboardsLabel })).toBeNull();
    fireEvent.click(findable);
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT" && c.path === "/api/v1/me/preferences")?.body)
      .toEqual({ findable: true }));
  });
});
