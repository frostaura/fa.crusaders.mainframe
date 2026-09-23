import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import AdminLayout from "../AdminLayout";
import {
  doorFixture, doorsServer, memberFixture, renderPage, signIn, signOut, stubFetch, type StubRoute,
} from "@/test/harness";

/**
 * The admin frame: the rail (xl+) and the section bar + sheet (below xl), both rendered from the one
 * IA list, both carrying the same three badges. jsdom applies no CSS, so both shapes are in the DOM
 * at once here — which is exactly what lets one test prove they agree.
 */

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

function Where() {
  const { pathname } = useLocation();
  return <p data-testid="where">{pathname}</p>;
}

function Page({ title }: { title: string }) {
  return <main id="main-content"><h1>{title}</h1><Where /></main>;
}

type Options = { pending?: number; silentDoors?: number; faults?: Record<string, number>; fail?: boolean };

function routes({ pending = 0, silentDoors = 0, faults = {}, fail = false }: Options): StubRoute[] {
  const whoami = signIn({ isAdmin: true });
  const doors = Array.from({ length: Math.max(silentDoors, 1) }, (_, i) => doorFixture({
    id: `99999999-9999-9999-9999-99999999000${i}`,
    name: `Door ${i + 1}`,
    gate_key: `door-${i + 1}`,
    last_seen_at: i < silentDoors ? ago(3600) : ago(5),
  }));
  const failed = { status: 503, body: { error: "upstream_unavailable" } };
  return [
    { path: "/api/v1/whoami", body: whoami },
    fail
      ? { path: "/api/v1/admin/members", ...failed }
      : { path: "/api/v1/admin/members", body: Array.from({ length: pending }, (_, i) => memberFixture({ id: `m${i}`, status: "PendingApproval" })) },
    fail
      ? { path: "/api/v1/admin/monitoring/summary", ...failed }
      : { path: "/api/v1/admin/monitoring/summary", body: { open: faults } },
    ...(fail ? [{ path: "/api/v1/admin/doors", ...failed }] : doorsServer(doors).routes),
  ];
}

function renderFrame(at: string) {
  return renderPage(
    <Routes>
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Page title="Overview" />} />
        <Route path="*" element={<Page title="Section" />} />
      </Route>
    </Routes>,
    { initialEntries: [at], reactStrictMode: true },
  );
}

function rail(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-admin-rail]");
  if (!element) throw new Error("no rail");
  return element;
}

beforeEach(() => {
  vi.stubGlobal("EventSource", class { close() {} addEventListener() {} } as unknown as typeof EventSource);
});

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("the admin rail", () => {
  it("marks the one current section, and only that one", async () => {
    stubFetch(routes({}));
    renderFrame("/admin/monitoring/doors/99999999-9999-9999-9999-999999999999");

    const nav = within(rail()).getByRole("navigation", { name: "Admin" });
    const current = await within(nav).findAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Doors");
    // The parent section does not light as well — the NavLink default that would have.
    expect(within(nav).getByRole("link", { name: "Control board" })).not.toHaveAttribute("aria-current");
  });

  it("lights the control board, not Doors, on /admin/monitoring", async () => {
    stubFetch(routes({}));
    renderFrame("/admin/monitoring");

    const nav = within(rail()).getByRole("navigation", { name: "Admin" });
    expect(await within(nav).findByRole("link", { name: "Control board" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Doors" })).not.toHaveAttribute("aria-current");
  });

  it("links every section — real anchors, so a section opens in a new tab", async () => {
    stubFetch(routes({}));
    renderFrame("/admin");

    const nav = within(rail()).getByRole("navigation", { name: "Admin" });
    const hrefs = within(nav).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/admin", "/admin/members", "/admin/groups", "/admin/transactions", "/admin/reports",
      "/admin/monitoring", "/admin/monitoring/doors", "/admin/monitoring/devices", "/admin/monitoring/faults",
      "/admin/monitoring/changes", "/admin/schedules", "/admin/courts", "/admin/settings", "/admin/webhooks",
    ]);
    // Grouped: each group is a list named by its heading.
    for (const group of ["People", "Money", "Courts & hardware", "Setup"]) {
      expect(within(nav).getByRole("list", { name: group })).toBeInTheDocument();
    }
  });

  it("badges Members, Doors and Faults with the count in the digits and the sentence in the name", async () => {
    stubFetch(routes({ pending: 2, silentDoors: 1, faults: { critical: 1, warning: 2, info: 7 } }));
    renderFrame("/admin");

    const nav = within(rail()).getByRole("navigation", { name: "Admin" });
    expect(await within(nav).findByRole("link", { name: "Members, 2 membership applications awaiting review" })).toBeInTheDocument();
    expect(await within(nav).findByRole("link", { name: "Doors, 1 door needs attention" })).toBeInTheDocument();
    // Info rows (boots) are not counted: 1 critical + 2 warning.
    const faults = await within(nav).findByRole("link", { name: "Faults, 3 faults need attention" });
    const digits = faults.querySelector("[data-admin-badge='faults']");
    expect(digits).toHaveTextContent("3");
    // The digits are decoration: the sentence is the name, so they are hidden from the tree.
    expect(digits).toHaveAttribute("aria-hidden", "true");
    // Every link is a 44px target.
    for (const link of within(nav).getAllByRole("link")) expect(link.className).toContain("min-h-touch");
  });

  it("shows no badge at all when a read fails — a badge is a cue, not a screen", async () => {
    const stub = stubFetch(routes({ fail: true }));
    renderFrame("/admin");

    await waitFor(() => {
      expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/monitoring/summary"))).toBe(true);
      expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/doors"))).toBe(true);
    });
    const nav = within(rail()).getByRole("navigation", { name: "Admin" });
    expect(within(nav).getByRole("link", { name: "Members" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-admin-badge]")).toHaveLength(0);
  });
});

describe("the section switcher (below xl)", () => {
  it("names the current section on the bar", async () => {
    stubFetch(routes({ pending: 1 }));
    renderFrame("/admin/members");

    const bar = await screen.findByRole("button", { name: /Members.*change section/ });
    expect(bar).toHaveTextContent("People");
    // The page below keeps the only h1 — the bar names the section in words, not as a heading.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // The total rides on the bar too, so a phone admin on Settings still learns an application waits.
    expect(await screen.findByRole("button", { name: /1 membership application awaiting review/ })).toBe(bar);
  });

  it("opens the same grouped list in a sheet, and Escape returns focus to the bar", async () => {
    stubFetch(routes({}));
    renderFrame("/admin/settings");

    const bar = await screen.findByRole("button", { name: /Settings.*change section/ });
    bar.focus();
    fireEvent.click(bar);

    const sheet = await screen.findByRole("dialog", { name: "Admin sections" });
    const current = within(sheet).getByRole("link", { current: "page" });
    expect(current).toHaveAccessibleName("Settings");
    // 14 since P6 gave Courts its own page.
    expect(within(sheet).getAllByRole("link")).toHaveLength(14);

    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(bar).toHaveFocus());
  });

  it("closes with the × and hands focus back to the bar", async () => {
    stubFetch(routes({}));
    renderFrame("/admin/groups");

    const bar = await screen.findByRole("button", { name: /Groups.*change section/ });
    fireEvent.click(bar);
    const sheet = await screen.findByRole("dialog", { name: "Admin sections" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(bar).toHaveFocus());
  });

  it("navigates from a row, closes, and leaves focus for the new page rather than the bar", async () => {
    stubFetch(routes({}));
    renderFrame("/admin/settings");

    fireEvent.click(await screen.findByRole("button", { name: /Settings.*change section/ }));
    const sheet = await screen.findByRole("dialog", { name: "Admin sections" });
    await act(async () => { fireEvent.click(within(sheet).getByRole("link", { name: "Webhooks" })); });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/webhooks");
    const bar = screen.getByRole("button", { name: /Webhooks.*change section/ });
    // The route announcer moves focus to the new page's h1; the sheet must not snatch it back.
    expect(bar).not.toHaveFocus();
  });
});
