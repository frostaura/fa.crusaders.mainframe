import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, useLocation } from "react-router-dom";
import { AppRoutes } from "./App";
import { AuthProvider } from "./lib/auth";
import { routePageName } from "./lib/routeAnnouncer";
import { signIn, signOut, stubFetch } from "./test/harness";

/**
 * P13's member routes: buying minutes and a purchase's status page, and the old top-up URLs a
 * member may still hold — PayFast's return and cancel links among them. Each old URL is a
 * permanent redirect that keeps the id AND the query, because `?cancelled=1` is the only signal
 * PayFast gives that the member backed out (`minutes-and-packages.md` §3.1). The pages are
 * stand-ins; each has its own suite.
 */

vi.mock("./components/shell/AppShell", () => ({ default: () => <Outlet /> }));
const { page } = vi.hoisted(() => ({ page: (name: string) => ({ default: () => <h1>{name}</h1> }) }));
vi.mock("./pages/TopUp", () => page("buy minutes page"));
vi.mock("./pages/TopUpStatus", () => page("purchase status page"));

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

function Probe() {
  const { pathname, search, hash } = useLocation();
  return <output data-testid="at">{`${pathname}${search}${hash}`}</output>;
}

function renderAt(path: string) {
  const whoami = signIn({ isAdmin: false });
  stubFetch([{ path: "/api/v1/whoami", body: whoami }]);
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

async function arrivesAt(path: string, heading: string) {
  await waitFor(() => expect(screen.getByTestId("at").textContent).toBe(path));
  expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
}

describe("P13 routes", () => {
  it.each([
    ["/wallet/buy", "buy minutes page"],
    ["/wallet/buy/abc", "purchase status page"],
  ])("%s renders its page", async (path, heading) => {
    renderAt(path);
    await arrivesAt(path, heading);
  });

  it.each([
    ["/wallet/topup", "/wallet/buy", "buy minutes page"],
    ["/wallet/topup?returnTo=%2Fbookings", "/wallet/buy?returnTo=%2Fbookings", "buy minutes page"],
    ["/wallet/topup/abc?cancelled=1", "/wallet/buy/abc?cancelled=1", "purchase status page"],
    ["/wallet/topup/abc", "/wallet/buy/abc", "purchase status page"],
  ])("%s → %s", async (from, to, heading) => {
    renderAt(from);
    await arrivesAt(to, heading);
  });

  it("names the new routes for the tab title", () => {
    expect(routePageName("/wallet/buy")).toBe("Buy minutes");
    expect(routePageName("/wallet/buy/abc")).toBe("Buying minutes");
    expect(routePageName("/admin/packages")).toBe("Packages");
  });
});
