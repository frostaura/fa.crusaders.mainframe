import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import Layout from "../shell/AppShell";
import { ProfileProvider } from "../../lib/profile";
import { ThemeProvider } from "../../lib/theme";
import { tokenStore } from "../../lib/api";
import { LAST_KNOWN_KEY } from "../../lib/lastKnown";
import { readLastIdentity } from "../../lib/lastIdentity";
import { clearOfflineCache } from "../../lib/pwa";
import { wipeMemberData } from "../../lib/offline/queryCache";
import { wipeMemberCode } from "../../lib/memberCode/keyStore";
import { keepSettingsDraft, keptSettingsDraft } from "../../lib/settingsDraftStore";
import { DEMO_COPY } from "../../lib/demoModeCopy";
import { refuse, renderPage, signIn, signOut, SETTINGS_FIXTURE, stubFetch, type FetchStub } from "../../test/harness";
import { resetClubModeForTests } from "./clubMode";
import { leavePage, retryPause } from "./switchClub";

vi.mock("../../lib/pwa", async (original) => ({ ...(await original<typeof import("../../lib/pwa")>()), clearOfflineCache: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/offline/queryCache", async (original) => {
  const real = await original<typeof import("../../lib/offline/queryCache")>();
  return { ...real, wipeMemberData: vi.fn(real.wipeMemberData) };
});
vi.mock("../../lib/memberCode/keyStore", async (original) => {
  const real = await original<typeof import("../../lib/memberCode/keyStore")>();
  return { ...real, wipeMemberCode: vi.fn(() => Promise.resolve()) };
});

/**
 * The demo club (admins only): the account menu's Live / Demo choice trades the session for the
 * other club's and starts the app afresh with nothing of the last one; while in the demo a stripe
 * under the app bar says so on every route, and its Reset asks first.
 */

const DEMO_USER = "dddddddd-0000-4000-8000-00000000d3e0";
const DEMO_ANSWER = {
  access_token: "demo.token.value", user_id: DEMO_USER, is_admin: true, must_change_password: false,
  mode: "demo", generated_at: "2026-10-06T07:12:00Z",
};

const leave = vi.spyOn(leavePage, "to").mockImplementation(() => undefined);

beforeAll(async () => {
  // A lazy chunk races the test that opens it (gotchas-frontend): import it first.
  await import("../../demoMode");
});

beforeEach(() => {
  resetClubModeForTests();
  leave.mockClear();
  vi.mocked(clearOfflineCache).mockClear();
  vi.mocked(wipeMemberData).mockClear();
  vi.mocked(wipeMemberCode).mockClear();
});

afterEach(() => {
  signOut();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-demo-mode");
});

function renderShell(mode: "live" | "demo" | "demo_member", extra: Parameters<typeof stubFetch>[0] = []): { stub: FetchStub; userId: string } {
  const memberView = mode === "demo_member";
  const whoami = { ...signIn({ isAdmin: !memberView }), demo_member_view: memberView };
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_minutes: 120, entries: [], count: 0 } },
    { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "naledi@sample.local", full_name: "Naledi Dube", photo_url: null, membership_number: "C-104" } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/doors", body: { day_started_at: new Date().toISOString(), timezone: "Africa/Johannesburg", shut_all_active: false, doors: [] } },
    { path: "/api/v1/admin/mode", body: { mode: memberView ? "demo" : mode, club_name: "Crusaders Squash Club", demo: mode === "demo" ? { generated_at: DEMO_ANSWER.generated_at, stale_after_hours: 24 } : null } },
    ...extra,
  ]);
  renderPage(
    <ThemeProvider>
      <ProfileProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/my-code" element={<h1>Your code</h1>} />
          </Route>
        </Routes>
      </ProfileProvider>
    </ThemeProvider>,
    { initialEntries: ["/my-code"] },
  );
  return { stub, userId: whoami.user_id };
}

async function openMenu() {
  const trigger = await screen.findByRole("button", { name: "Account menu" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  await screen.findByRole("menu");
  await waitFor(() => expect(screen.getByRole("menuitemradio", { name: DEMO_COPY.live })).toHaveAttribute("aria-checked", "true"));
}

describe("switching to the demo club from the account menu", () => {
  it("adopts the demo session, wipes every per-person and per-club store, and loads the app afresh at My Code", async () => {
    const { stub, userId } = renderShell("live", [{ method: "POST", path: "/api/v1/admin/mode", body: DEMO_ANSWER }]);
    await waitFor(() => expect(readLastIdentity()).toBe(userId));
    localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify({ v: 4 }));
    keepSettingsDraft(userId, SETTINGS_FIXTURE as never, SETTINGS_FIXTURE as never);
    await openMenu();
    expect(screen.getByRole("menu")).toHaveTextContent(DEMO_COPY.menuLine);

    fireEvent.click(screen.getByRole("menuitemradio", { name: DEMO_COPY.demo }));

    await waitFor(() => expect(leave).toHaveBeenCalledWith("/my-code"));
    expect(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/admin/mode").map((c) => c.body)).toEqual([{ mode: "demo" }]);
    expect(tokenStore.get()).toBe("demo.token.value");
    expect(readLastIdentity()).toBe(DEMO_USER);
    expect(clearOfflineCache).toHaveBeenCalled();
    expect(wipeMemberData).toHaveBeenCalled();
    expect(wipeMemberCode).toHaveBeenCalled();
    expect(localStorage.getItem(LAST_KNOWN_KEY)).toBeNull();
    expect(keptSettingsDraft(userId)).toBeNull();
    // Still busy while the page leaves: the choice it is going to is the checked one.
    expect(screen.getByRole("menuitemradio", { name: DEMO_COPY.demo })).toHaveAttribute("aria-checked", "true");
  });

  it("asks again when the gateway cuts off a switch the club is still drawing, and goes in on the answer", async () => {
    retryPause.ms = 0;
    try {
      const { stub } = renderShell("live", [{
        method: "POST", path: "/api/v1/admin/mode",
        // Cloudflare's 524, then nginx's 504, while the Pi draws the club; then the club's answer.
        sequence: [refuse(524, "<html>timeout</html>"), refuse(504, "<html>gateway</html>"), DEMO_ANSWER],
      }]);
      await openMenu();

      fireEvent.click(screen.getByRole("menuitemradio", { name: DEMO_COPY.demo }));

      await waitFor(() => expect(leave).toHaveBeenCalledWith("/my-code"));
      expect(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/admin/mode")).toHaveLength(3);
      expect(tokenStore.get()).toBe("demo.token.value");
      expect(screen.queryByText(/Couldn't open the demo club/)).not.toBeInTheDocument();
    } finally {
      retryPause.ms = 2_000;
    }
  });

  it("stays in the live club, says why, and keeps the session when the club refuses", async () => {
    renderShell("live", [{ method: "POST", path: "/api/v1/admin/mode", ...refuse(503, { error: "unavailable" }) }]);
    await openMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: DEMO_COPY.demo }));

    expect(await screen.findByText(/Couldn't open the demo club/)).toBeInTheDocument();
    expect(leave).not.toHaveBeenCalled();
    expect(tokenStore.get()).toBe("test.token.value");
    expect(clearOfflineCache).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: DEMO_COPY.live })).toHaveAttribute("aria-checked", "true"));
  });
});

describe("the demo stripe", () => {
  it("is not drawn in the live club", async () => {
    const { stub } = renderShell("live");
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/admin/mode")).toBe(true));
    await screen.findByRole("button", { name: "Account menu" });
    expect(screen.queryByRole("region", { name: DEMO_COPY.stripeTitle })).toBeNull();
    expect(document.documentElement.hasAttribute("data-demo-mode")).toBe(false);
  });

  it("says demo mode under the app bar in the demo, and Reset asks before it wipes anything", async () => {
    const { stub } = renderShell("demo", [{ method: "POST", path: "/api/v1/admin/demo/reset", body: { generated_at: "2026-10-06T09:00:00Z" } }]);
    const stripe = await screen.findByRole("region", { name: DEMO_COPY.stripeTitle });
    expect(stripe).toHaveTextContent(`${DEMO_COPY.stripeTitle} · ${DEMO_COPY.stripeDetail}`);
    expect(stripe.closest("[data-app-header]")).not.toBeNull();
    expect(document.documentElement.hasAttribute("data-demo-mode")).toBe(true);

    fireEvent.click(within(stripe).getByRole("button", { name: DEMO_COPY.reset }));
    const dialog = await screen.findByRole("dialog", { name: DEMO_COPY.resetTitle });
    expect(dialog).toHaveTextContent(DEMO_COPY.resetBody);
    expect(within(dialog).getByRole("button", { name: /close/i })).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path === "/api/v1/admin/demo/reset")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: DEMO_COPY.resetConfirm }));
    // The page reloads where it is (no id in the path); the harness's router is a memory one.
    await waitFor(() => expect(leave).toHaveBeenCalledWith(window.location.pathname + window.location.search));
    expect(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/admin/demo/reset")).toHaveLength(1);
    expect(wipeMemberData).toHaveBeenCalled();
  });
});

describe("the demo club as a member", () => {
  const MEMBER_ANSWER = { ...DEMO_ANSWER, user_id: "dddddddd-0000-4000-8000-00000000d3e1", is_admin: false, mode: "demo_member" };

  it("is offered only inside the demo", async () => {
    renderShell("live");
    await openMenu();
    expect(screen.queryByRole("menuitemradio", { name: DEMO_COPY.demoMember })).toBeNull();
  });

  it("switches from the demo into the member view and loads the app afresh at My Code", async () => {
    const { stub } = renderShell("demo", [{ method: "POST", path: "/api/v1/admin/mode", body: MEMBER_ANSWER }]);
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    await screen.findByRole("menu");

    fireEvent.click(await screen.findByRole("menuitemradio", { name: DEMO_COPY.demoMember }));

    await waitFor(() => expect(leave).toHaveBeenCalledWith("/my-code"));
    expect(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/admin/mode").map((c) => c.body)).toEqual([{ mode: "demo_member" }]);
    expect(tokenStore.get()).toBe("demo.token.value");
    expect(readLastIdentity()).toBe(MEMBER_ANSWER.user_id);
  });

  it("wears the demo stripe as a member: no Reset, no admin menu, and a way back to the admin view", async () => {
    const { stub } = renderShell("demo_member", [{ method: "POST", path: "/api/v1/me/demo/mode", body: DEMO_ANSWER }]);
    const stripe = await screen.findByRole("region", { name: DEMO_COPY.stripeTitle });
    expect(stripe).toHaveTextContent(`${DEMO_COPY.stripeTitle} · ${DEMO_COPY.stripeMemberDetail}`);
    expect(within(stripe).queryByRole("button", { name: DEMO_COPY.reset })).toBeNull();
    expect(document.documentElement.hasAttribute("data-demo-mode")).toBe(true);
    // The persona is not an admin: the admin route that reads the mode is never asked.
    expect(stub.calls.some((c) => c.path === "/api/v1/admin/mode")).toBe(false);

    fireEvent.click(within(stripe).getByRole("button", { name: DEMO_COPY.backToAdmin }));

    await waitFor(() => expect(leave).toHaveBeenCalledWith("/my-code"));
    expect(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/me/demo/mode").map((c) => c.body)).toEqual([{ mode: "demo" }]);
    expect(stub.calls.some((c) => c.method === "POST" && c.path === "/api/v1/admin/mode")).toBe(false);
  });

  it("goes all the way back to the live club from the member view", async () => {
    const { stub } = renderShell("demo_member", [{ method: "POST", path: "/api/v1/me/demo/mode", body: { ...DEMO_ANSWER, mode: "live" } }]);
    const stripe = await screen.findByRole("region", { name: DEMO_COPY.stripeTitle });

    fireEvent.click(within(stripe).getByRole("button", { name: DEMO_COPY.backToLive }));

    await waitFor(() => expect(leave).toHaveBeenCalledWith("/my-code"));
    expect(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/me/demo/mode").map((c) => c.body)).toEqual([{ mode: "live" }]);
  });
});
