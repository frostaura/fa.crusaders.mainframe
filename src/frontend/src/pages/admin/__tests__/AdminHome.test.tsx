import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminHome from "../AdminHome";
import { ADMIN_NAV_ITEMS, PENDING_APPLICATIONS_HREF } from "@/components/admin/adminNav";
import {
  doorFixture, doorsServer, memberFixture, refuse, renderPage, signIn, signOut, stubFetch, type StubRoute,
} from "@/test/harness";

/**
 * The console's Overview: "Needs attention", then every section.
 *
 * The rule the whole page is built round — an empty collection on a failed read is NOT an answer —
 * gets the most tests: a page that said "All clear" because its fault read failed would send an
 * admin home on the night a court box died.
 */

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const FAILED = { status: 503, body: { error: "upstream_unavailable" } };

type Setup = {
  pending?: number;
  silentDoors?: number;
  faults?: Record<string, number>;
  members?: Partial<StubRoute>;
  summary?: Partial<StubRoute>;
  doors?: StubRoute[];
};

function setup(options: Setup = {}) {
  const { pending = 0, silentDoors = 0, faults = {} } = options;
  const whoami = signIn({ isAdmin: true });
  const doors = [
    doorFixture({ name: "Front door", gate_key: "front", last_seen_at: silentDoors > 0 ? ago(3600) : ago(5) }),
    doorFixture({ id: "99999999-9999-9999-9999-99999999aaaa", name: "Side door", gate_key: "side", last_seen_at: silentDoors > 1 ? ago(3600) : ago(5) }),
  ];
  return stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    {
      path: "/api/v1/admin/members",
      body: Array.from({ length: pending }, (_, i) => memberFixture({ id: `m${i}`, status: "PendingApproval" })),
      ...options.members,
    },
    { path: "/api/v1/admin/monitoring/summary", body: { open: faults }, ...options.summary },
    ...(options.doors ?? doorsServer(doors).routes),
  ]);
}

function renderHome() {
  return renderPage(<AdminHome />, { initialEntries: ["/admin"], reactStrictMode: true });
}

function needsAttention(): HTMLElement {
  return screen.getByRole("region", { name: "Needs attention" });
}

beforeEach(() => {
  vi.stubGlobal("EventSource", class { close() {} addEventListener() {} } as unknown as typeof EventSource);
});

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("the admin Overview", () => {
  it("is a page with one h1, a refresh on the right, and both sections", async () => {
    setup();
    renderHome();

    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh overview" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Needs attention" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Console" })).toBeInTheDocument();
    await screen.findByText("All clear");
  });

  it("shows a skeleton, not 'Loading…' and never 'All clear', while the first read is out", async () => {
    // Every read hangs: the page must say it is reading, in a status, over a layout-shaped skeleton.
    // They are released (as failures) at the end: the doors store is module-level and shares its
    // in-flight read, so a request left hanging would hold every later test's doors read with it.
    const whoami = JSON.stringify(signIn({ isAdmin: true }));
    const hanging: Array<(reason: Error) => void> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/v1/whoami")) {
        return Promise.resolve(new Response(whoami, { status: 200, headers: { "content-type": "application/json" } }));
      }
      return new Promise<Response>((_, reject) => { hanging.push(reject); });
    }));
    const { unmount } = renderHome();

    const region = needsAttention();
    const busy = region.querySelector("[aria-busy='true']");
    expect(busy).not.toBeNull();
    expect(within(region).getByRole("status")).toHaveTextContent("Checking what needs attention…");
    expect(region.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);
    expect(within(region).queryByText("All clear")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Loading/)).not.toBeInTheDocument();
    // Still reading once the session is known to be an admin one: the reads, not the auth probe.
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/admin/monitoring/summary"), expect.anything()));
    expect(within(needsAttention()).queryByText("All clear")).not.toBeInTheDocument();
    expect(needsAttention().querySelector("[aria-busy='true']")).not.toBeNull();

    unmount();
    for (const reject of hanging) reject(new Error("released by the test"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not flash All clear while the session is still being checked", async () => {
    // The auth probe answers slowly; nothing has been allowed to read yet, so nothing is known.
    setup();
    renderHome();
    expect(within(needsAttention()).queryByText("All clear")).not.toBeInTheDocument();
    expect(needsAttention().querySelector("[aria-busy='true']")).not.toBeNull();
    await within(needsAttention()).findByText("All clear");
  });

  it("says All clear only when all three reads answered and nothing is waiting", async () => {
    // Boots are recorded at info; they are not faults that need somebody.
    setup({ faults: { info: 12 } });
    renderHome();

    const region = needsAttention();
    expect(await within(region).findByText("All clear")).toBeInTheDocument();
    expect(within(region).getByText(/every door is reporting/)).toBeInTheDocument();
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("links each thing waiting to where it is dealt with, and names it by its sentence", async () => {
    setup({ pending: 1, silentDoors: 1, faults: { critical: 1, error: 1, info: 3 } });
    renderHome();

    const region = needsAttention();
    const pending = await within(region).findByRole("link", { name: "1 membership application awaiting review" });
    expect(pending).toHaveAttribute("href", PENDING_APPLICATIONS_HREF);
    expect(pending).toHaveAttribute("data-watermark", "card");

    const doors = await within(region).findByRole("link", { name: "1 door needs attention" });
    expect(doors).toHaveAttribute("href", "/admin/monitoring/doors");
    // The door's own sentence, from the doors store, is the card's description.
    expect(doors).toHaveAccessibleDescription(/Front door/);

    const faults = within(region).getByRole("link", { name: "2 faults need attention" });
    expect(faults).toHaveAttribute("href", "/admin/monitoring/faults");
    expect(within(faults).getByText("1 critical")).toBeInTheDocument();
    expect(within(faults).getByText("1 error")).toBeInTheDocument();

    expect(within(region).queryByText("All clear")).not.toBeInTheDocument();
  });

  it("shows a source with nothing waiting as calm text, not as a link", async () => {
    setup({ pending: 2 });
    renderHome();

    const region = needsAttention();
    await within(region).findByRole("link", { name: "2 membership applications awaiting review" });
    expect(within(region).getByText("Every door is reporting.")).toBeInTheDocument();
    expect(within(region).getByText("No faults need attention.")).toBeInTheDocument();
    expect(within(region).getAllByRole("link")).toHaveLength(1);
  });

  it("never says All clear over a failed read — it says what could not be read, and offers a retry", async () => {
    const stub = setup({ summary: FAILED });
    renderHome();

    const region = needsAttention();
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t read the hardware faults");
    expect(alert).toHaveTextContent("doesn’t mean all is well");
    expect(within(region).queryByText("All clear")).not.toBeInTheDocument();
    // The faults card says it does not know, rather than "No faults need attention".
    expect(within(region).queryByText("No faults need attention.")).not.toBeInTheDocument();
    expect(region.querySelector("[data-attention-card='faults']")).toHaveAttribute("data-state", "failed");

    const before = stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/monitoring/summary")).length;
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/monitoring/summary")).length)
      .toBeGreaterThan(before));
  });

  it("recovers to the real answer when the retry succeeds", async () => {
    // Down until the admin presses Try again, whatever number of reads the page made before that.
    let down = true;
    setup({ summary: { respond: () => (down ? refuse(503, { error: "upstream_unavailable" }) : { open: { warning: 1 } }) } });
    renderHome();

    const region = needsAttention();
    const retry = await within(region).findByRole("button", { name: "Try again" });
    down = false;
    fireEvent.click(retry);
    expect(await within(region).findByRole("link", { name: "1 fault needs attention" })).toBeInTheDocument();
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("names every failed source in one sentence", async () => {
    setup({ members: FAILED, summary: FAILED, doors: [{ path: "/api/v1/admin/doors", ...FAILED }] });
    renderHome();

    const alert = await within(needsAttention()).findByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent(
      "Couldn’t read the membership applications, the doors and the hardware faults.",
    ));
    expect(within(needsAttention()).queryByText("All clear")).not.toBeInTheDocument();
  });

  it("lists every console section with what it is for, badges included", async () => {
    setup({ pending: 3 });
    renderHome();

    const console = screen.getByRole("region", { name: "Console" });
    const links = within(console).getAllByRole("link");
    const expected = ADMIN_NAV_ITEMS.filter((item) => item.id !== "overview");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(expected.map((item) => item.path));
    for (const item of expected) expect(within(console).getByText(item.description)).toBeInTheDocument();
    // Interactive cards carry the fingerprint.
    for (const link of links) expect(link).toHaveAttribute("data-watermark", "card");
    expect(await within(console).findByRole("link", { name: /Members, 3 membership applications awaiting review/ }))
      .toBeInTheDocument();
  });
});
