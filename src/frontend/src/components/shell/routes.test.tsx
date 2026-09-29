import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, useLocation } from "react-router-dom";
import { AppRoutes } from "../../App";
import { AuthProvider } from "../../lib/auth";
import { tokenStore } from "../../lib/api";
import { forgetLastKnown } from "../../lib/lastKnown";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * The P2 route map, driven through the real `<Routes>` (Target IA → Routes).
 *
 * <p>
 * The pages and the shell are stand-ins here on purpose: what is under test is WHERE a URL ends
 * up — the landing, the renames, the role-split `/reports`, the nested admin guard — and every
 * page has its own suite. Each stand-in renders an `h1` naming itself, and a probe prints the
 * final location including query and hash, because "keeps the query" is half of every redirect's
 * contract (a door log's filter, a bookings date, a deep link out of an email).
 * </p>
 */

vi.mock("./AppShell", () => ({ default: () => <Outlet /> }));
vi.mock("../admin/AdminLayout", () => ({
  default: () => <div data-admin-layout=""><p>admin rail</p><Outlet /></div>,
}));
const { page } = vi.hoisted(() => ({ page: (name: string) => ({ default: () => <h1>{name}</h1> }) }));
vi.mock("../../pages/MyCode", () => page("my code page"));
vi.mock("../../pages/Schedule", () => page("bookings page"));
vi.mock("../../pages/Wallet", () => page("wallet page"));
vi.mock("../../pages/WalletActivity", () => page("wallet activity page"));
vi.mock("../../pages/AdminLedger", () => page("transactions page"));
vi.mock("../../pages/AdminMembers", () => page("members page"));
vi.mock("../../pages/admin/AdminHome", () => page("admin overview page"));
vi.mock("../../pages/admin/AdminReports", () => page("club reports page"));
vi.mock("../../pages/admin/AdminCourts", () => page("courts page"));
// P5 — the member page's frame is a layout with an <Outlet />, and each tab a named export.
vi.mock("../../pages/admin/member", () => {
  const tab = (name: string) => () => <h1>{name}</h1>;
  return {
    default: () => <div><p>member frame</p><Outlet /></div>,
    MemberOverview: tab("member overview tab"),
    MemberWallet: tab("member wallet tab"),
    MemberBookings: tab("member bookings tab"),
    MemberDoors: tab("member door history tab"),
    MemberNightTab: tab("member night tab"),
    MemberAccess: tab("member access tab"),
  };
});
vi.mock("../../pages/AdminDoorsLog", () => ({ AdminDoorsLogPage: () => <h1>door log page</h1> }));
vi.mock("../../pages/AdminDoorsCard", () => ({ AdminDoorsCardPage: () => <h1>door card page</h1> }));

const LAST_IDENTITY_KEY = "crusaders.mainframe.last-identity";

afterEach(() => {
  vi.unstubAllGlobals();
  signOut();
  forgetLastKnown();
  localStorage.clear();
});

function Probe() {
  const { pathname, search, hash } = useLocation();
  return <output data-testid="at">{`${pathname}${search}${hash}`}</output>;
}

function renderAt(path: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppRoutes />
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

function session(isAdmin: boolean) {
  const whoami = signIn({ isAdmin });
  stubFetch([{ path: "/api/v1/whoami", body: whoami }]);
}

async function arrivesAt(path: string, heading: string) {
  await waitFor(() => expect(screen.getByTestId("at")).toHaveTextContent(path));
  expect(screen.getByTestId("at").textContent).toBe(path);
  expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
}

describe("R15 — My Code is the landing", () => {
  it("sends a signed-in member from / to /my-code", async () => {
    session(false);
    renderAt("/");
    await arrivesAt("/my-code", "my code page");
  });

  it("does the same with no signal, for a member this device has confirmed (D3)", async () => {
    tokenStore.set("member.jwt.value");
    localStorage.setItem(LAST_IDENTITY_KEY, "44444444-4444-4444-4444-444444444444");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));

    renderAt("/");

    // The marketing page to a member at a locked door with no signal is the worst of the answers.
    await arrivesAt("/my-code", "my code page");
    expect(screen.queryByText(/Can't reach the club/i)).not.toBeInTheDocument();
  });

  it("keeps the public landing for a visitor", async () => {
    stubFetch([]);
    renderAt("/");
    expect(await screen.findByRole("heading", { level: 1, name: /Crusaders Squash/ })).toBeInTheDocument();
    expect(screen.getByTestId("at").textContent).toBe("/");
  });
});

describe("renamed URLs are permanent redirects that keep the query and the hash", () => {
  it.each([
    ["/schedule?date=2026-09-24#court-2", "/bookings?date=2026-09-24#court-2", "bookings page", false],
    ["/court-code?from=email", "/my-code?from=email", "my code page", false],
    ["/admin/ledger?member=abc", "/admin/transactions?member=abc", "transactions page", true],
    ["/admin/biometric", "/admin/members", "members page", true],
    ["/admin/doors/log?door=d1", "/admin/monitoring/doors/log?door=d1", "door log page", true],
    ["/admin/doors/d1/card", "/admin/monitoring/doors/d1/card", "door card page", true],
  ])("%s → %s", async (from, to, heading, admin) => {
    session(admin);
    renderAt(from);
    await arrivesAt(to, heading);
  });
});

describe("/reports is split by who is asking", () => {
  it("takes an admin to the club's reports", async () => {
    session(true);
    renderAt("/reports?from=2026-09-01");
    await arrivesAt("/admin/reports?from=2026-09-01", "club reports page");
  });

  it("takes a member to their own wallet activity", async () => {
    session(false);
    renderAt("/reports?from=2026-09-01");
    await arrivesAt("/wallet/activity?from=2026-09-01", "wallet activity page");
  });
});

describe("the Admin section is one guarded, nested route (R16)", () => {
  it("renders the Overview inside the admin frame at /admin", async () => {
    session(true);
    renderAt("/admin");
    await arrivesAt("/admin", "admin overview page");
    expect(screen.getByText("admin rail")).toBeInTheDocument();
  });

  it("renders a child page inside the same frame", async () => {
    session(true);
    renderAt("/admin/transactions");
    await arrivesAt("/admin/transactions", "transactions page");
    expect(screen.getByText("admin rail")).toBeInTheDocument();
  });

  it("renders Courts (P6) inside the same frame", async () => {
    session(true);
    renderAt("/admin/courts");
    await arrivesAt("/admin/courts", "courts page");
    expect(screen.getByText("admin rail")).toBeInTheDocument();
  });

  /**
   * P5 / R17 — a member's page, and each tab a URL of its own inside BOTH frames: the console's
   * and the member's. "A person's night should be navigated from clicking member in grid" is
   * only true if `/admin/members/:id/night` is a real place a link can go.
   */
  it.each([
    ["/admin/members/7f1c", "member overview tab"],
    ["/admin/members/7f1c/wallet", "member wallet tab"],
    ["/admin/members/7f1c/bookings", "member bookings tab"],
    ["/admin/members/7f1c/doors", "member door history tab"],
    ["/admin/members/7f1c/night?day=2026-09-20", "member night tab"],
    ["/admin/members/7f1c/access", "member access tab"],
  ])("renders %s as the %s, inside the member's frame", async (path, heading) => {
    session(true);
    renderAt(path);
    await arrivesAt(path, heading);
    expect(screen.getByText("admin rail")).toBeInTheDocument();
    expect(screen.getByText("member frame")).toBeInTheDocument();
  });

  it("sends a member who follows an admin link to their own landing, frame and all withheld", async () => {
    session(false);
    renderAt("/admin/members");
    await arrivesAt("/my-code", "my code page");
    expect(screen.queryByText("admin rail")).not.toBeInTheDocument();
  });

  it("sends a signed-out visitor to sign in, remembering where they were going", async () => {
    stubFetch([]);
    renderAt("/admin/members");
    await waitFor(() => expect(screen.getByTestId("at")).toHaveTextContent("/login"));
  });
});

describe("an unknown path is a real 404", () => {
  it("says so rather than redirecting", async () => {
    session(false);
    renderAt("/nothing/here");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to My Code" })).toHaveAttribute("href", "/my-code");
    expect(screen.getByTestId("at").textContent).toBe("/nothing/here");
  });
});
