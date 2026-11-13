import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HomePage from "./pages/Home";
import { AuthShell } from "./components/AuthShell";
import { CrestLink } from "./components/shell/Crest";
import { routeTitle } from "./lib/routeAnnouncer";
import { loadClubIdentity, setClubIdentityForTests, shortClubName, useClubIdentity } from "./lib/clubIdentity";
import { GENERIC_FACTS, clubProfile } from "./lib/clubProfiles";
import { renderPage, signOut, stubFetch } from "./test/harness";

/**
 * Go-live FM-8 — the member app named Crusaders in its crest, sign-in band, pass, tab titles and
 * public page, in a multi-tenant product. The name is the tenant's now (`GET /api/v1/auth/club`),
 * so every test here puts a club that is NOT Crusaders in place: one club cannot tell "this club's
 * name" from "the only name there is".
 */
const HARBOUR = { slug: "harbour", name: "Harbour Racquets Club" };

afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

describe("the club's name is the tenant's (FM-8)", () => {
  it("the crest, the tab title and the sign-in band name the club this address serves", () => {
    setClubIdentityForTests(HARBOUR);
    render(<MemoryRouter><CrestLink to="/" /><AuthShell subline="Court bookings."><p>form</p></AuthShell></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Harbour Racquets — home" })).toBeInTheDocument();
    expect(routeTitle("/bookings")).toBe("Bookings — Harbour Racquets");
    expect(document.querySelector("[data-auth-club]")).toHaveTextContent("Harbour Racquets Club");
    expect(document.body.textContent).not.toMatch(/Crusaders/);
  });

  it("a club with no profile of its own gets facts true at any club, and no other club's place", () => {
    setClubIdentityForTests(HARBOUR);
    render(<MemoryRouter><AuthShell subline="Court bookings."><p>form</p></AuthShell></MemoryRouter>);
    const panel = screen.getByRole("region", { name: "Harbour Racquets Club" });
    for (const fact of GENERIC_FACTS) expect(within(panel).getByText(fact)).toBeInTheDocument();
    expect(within(panel).queryByText(clubProfile("crusaders")!.place)).toBeNull();
  });

  it("unknown, the chrome says no name rather than borrowing one", () => {
    setClubIdentityForTests(null);
    render(<MemoryRouter><CrestLink to="/" /><AuthShell subline="Court bookings."><p>form</p></AuthShell></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(routeTitle("/bookings")).toBe("Bookings");
    expect(document.querySelector("[data-auth-club]")).toBeNull();
  });

  it("another club's public page is that club's name over what is true at any club", async () => {
    setClubIdentityForTests(HARBOUR);
    stubFetch([{ path: "/api/v1/whoami", status: 401, body: { error: "unauthenticated" } }]);
    renderPage(<HomePage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Harbour Racquets Club" })).toBeInTheDocument();
    expect(screen.getByText(/hold your code up to the scanner on the court box/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Crusaders|Durban|league/i);
  });

  it("Crusaders keeps its own page", async () => {
    setClubIdentityForTests({ slug: "crusaders", name: "Crusaders Squash Club" });
    stubFetch([{ path: "/api/v1/whoami", status: 401, body: { error: "unauthenticated" } }]);
    renderPage(<HomePage />);
    expect(await screen.findByText(/part of Durban North since the mid-1960s/i)).toBeInTheDocument();
  });

  it("before the first answer on a new phone, the public page draws its shape, not a club", async () => {
    setClubIdentityForTests(null, false);
    stubFetch([{ path: "/api/v1/whoami", status: 401, body: { error: "unauthenticated" } }]);
    renderPage(<HomePage />);
    await waitFor(() => expect(document.querySelector("[aria-busy='true']")).not.toBeNull());
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

describe("reading the club (FM-8)", () => {
  function Probe() {
    const { club, settled } = useClubIdentity();
    return <output data-testid="club">{settled ? club?.name ?? "none" : "asking"}</output>;
  }

  it("takes the API's answer and keeps it for the next visit", async () => {
    setClubIdentityForTests(null, false);
    stubFetch([{ path: "/api/v1/auth/club", body: HARBOUR }]);
    render(<Probe />);
    await act(async () => { await loadClubIdentity(); });
    expect(screen.getByTestId("club")).toHaveTextContent("Harbour Racquets Club");
    expect(JSON.parse(window.localStorage.getItem("crusaders.mainframe.club")!)).toEqual(HARBOUR);
  });

  it("a failed read keeps what the phone already knew", async () => {
    setClubIdentityForTests(HARBOUR, false);
    stubFetch([{ path: "/api/v1/auth/club", status: 503, body: { error: "service_busy" } }]);
    render(<Probe />);
    await act(async () => { await loadClubIdentity(); });
    expect(screen.getByTestId("club")).toHaveTextContent("Harbour Racquets Club");
  });

  it("a club row with no name ('the club') is no name, not a name", async () => {
    setClubIdentityForTests(null, false);
    stubFetch([{ path: "/api/v1/auth/club", body: { slug: "x", name: "the club" } }]);
    render(<Probe />);
    await act(async () => { await loadClubIdentity(); });
    expect(screen.getByTestId("club")).toHaveTextContent("none");
  });

  it("drops a trailing 'Club' for the bar, the pass and the tab, and nothing else", () => {
    expect(shortClubName("Crusaders Squash Club")).toBe("Crusaders Squash");
    expect(shortClubName("Harbour Racquets")).toBe("Harbour Racquets");
    expect(shortClubName("Club")).toBe("Club");
  });
});
