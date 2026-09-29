import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, useLocation } from "react-router-dom";
import { AppRoutes } from "./App";
import { AuthProvider } from "./lib/auth";
import { routePageName } from "./lib/routeAnnouncer";
import { signIn, signOut, stubFetch } from "./test/harness";

/**
 * P11's routes: a booking's own page, invites (tab, shared link, email deep link), the inbox,
 * and the old names a booking could have been linked by — each a permanent redirect that keeps
 * the id, the query and the hash. The pages are stand-ins; each has its own suite.
 */

vi.mock("./components/Layout", () => ({ default: () => <Outlet /> }));
const { page } = vi.hoisted(() => ({ page: (name: string) => ({ default: () => <h1>{name}</h1> }) }));
vi.mock("./pages/Schedule", () => page("bookings page"));
vi.mock("./pages/BookingDetail", () => page("booking page"));
vi.mock("./pages/Invites", () => page("invites page"));
vi.mock("./pages/InviteLink", () => page("invite link page"));
vi.mock("./pages/InviteDeepLink", () => page("invite deep link page"));
vi.mock("./pages/Inbox", () => page("inbox page"));

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

describe("P11 routes", () => {
  it.each([
    ["/bookings/b1", "booking page"],
    ["/bookings/invites", "invites page"],
    ["/j/AbCdEfGhIjKlMnOpQrStUv", "invite link page"],
    ["/invites/p1", "invite deep link page"],
    ["/inbox", "inbox page"],
  ])("%s renders its page", async (path, heading) => {
    renderAt(path);
    await arrivesAt(path, heading);
  });

  it.each([
    ["/schedule/b1?from=email#money", "/bookings/b1?from=email#money", "booking page"],
    ["/booking/b1", "/bookings/b1", "booking page"],
    ["/invites", "/bookings/invites", "invites page"],
  ])("%s → %s", async (from, to, heading) => {
    renderAt(from);
    await arrivesAt(to, heading);
  });

  it("names every new route for the tab title", () => {
    expect(routePageName("/bookings/b1")).toBe("Booking");
    expect(routePageName("/bookings/invites")).toBe("Invites");
    expect(routePageName("/j/token")).toBe("Invite");
    expect(routePageName("/invites/p1")).toBe("Invite");
    expect(routePageName("/inbox")).toBe("Notifications");
  });
});
