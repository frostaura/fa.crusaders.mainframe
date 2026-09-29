import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminHome from "../AdminHome";
import { ADMIN_NAV_ITEMS, PENDING_APPLICATIONS_HREF } from "@/components/admin/adminNav";
import {
  doorFixture, doorsServer, memberFixture, refuse, renderPage, signIn, signOut, stubFetch, type StubRoute,
} from "@/test/harness";
import { noticeFixture } from "@/components/notifications/fixtures";
import { EMAIL_ALERTS_COPY, EMAIL_ALERTS_HREF, RECENT_ALERTS_COPY } from "@/lib/notificationsCopy";

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
  /** The Recent alerts feed (R23). Default: answered, empty. */
  notices?: Partial<StubRoute>;
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
    { path: "/api/v1/admin/notifications", body: { items: [], next_cursor: null }, ...options.notices },
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

  it("says no doors are set up when the club has none, never that every door is reporting (F3.13)", async () => {
    setup({ pending: 1, doors: doorsServer([]).routes });
    renderHome();

    const region = needsAttention();
    expect(await within(region).findByText("No doors set up yet.")).toBeInTheDocument();
    expect(within(region).queryByText("Every door is reporting.")).toBeNull();
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

describe("the Overview's Recent alerts (R23)", () => {
  const alerts = () => screen.getByRole("region", { name: RECENT_ALERTS_COPY.title });
  const feedCalls = (stub: ReturnType<typeof setup>) => stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/notifications"));

  it("lists what every admin was told, newest first: the headline names each row, which links to where it is dealt with", async () => {
    setup({
      notices: {
        body: {
          items: [
            noticeFixture({ headline: "Thandi Mokoena applied to join", link: "/admin/members" }),
            noticeFixture({
              kind: "device.offline", title: "Court box or door stopped reporting", headline: "Court 2 box stopped reporting",
              link: "/admin/monitoring/devices", created_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
              delivery: { state: "failed", sent_at: null, finished_at: new Date().toISOString(), recipients: 0 },
            }),
          ],
          next_cursor: null,
        },
      },
    });
    renderHome();

    const first = await within(alerts()).findByRole("link", { name: "Thandi Mokoena applied to join" });
    expect(first).toHaveAttribute("href", "/admin/members");
    expect(first).toHaveAccessibleDescription("New membership applications, 5 min ago. Emailed 3 admins.");
    const second = within(alerts()).getByRole("link", { name: "Court 2 box stopped reporting" });
    expect(second).toHaveAccessibleDescription(/3 h ago\. Email failed\./);
    expect(second.querySelector("[data-delivery='failed']")).toHaveTextContent("Email failed");
    // No older page: nothing to load.
    expect(within(alerts()).queryByRole("button", { name: RECENT_ALERTS_COPY.loadMore })).toBeNull();
  });

  it("a notice with nowhere to go is plain text, not a link", async () => {
    setup({ notices: { body: { items: [noticeFixture({ headline: "A thing happened", link: null })], next_cursor: null } } });
    renderHome();

    expect(await within(alerts()).findByText("A thing happened")).toBeInTheDocument();
    // The one link in the section is the way to the email switches (F3.11), not the notice.
    expect(within(alerts()).queryAllByRole("link").filter((a) => a.getAttribute("href") !== EMAIL_ALERTS_HREF)).toHaveLength(0);
  });

  it("links to the email alert switches from the alerts themselves (F3.11)", async () => {
    setup();
    renderHome();
    expect(await within(alerts()).findByRole("link", { name: EMAIL_ALERTS_COPY.chooseLink })).toHaveAttribute("href", EMAIL_ALERTS_HREF);
  });

  it("says there are none only when the read answered with none", async () => {
    setup();
    renderHome();
    expect(await within(alerts()).findByText(RECENT_ALERTS_COPY.emptyTitle)).toBeInTheDocument();
  });

  it("shows a skeleton while reading, and a failed read with a retry — never 'No alerts yet'", async () => {
    let down = true;
    const stub = setup({
      notices: { respond: () => (down ? refuse(429, { error: "rate_limited" }) : { items: [noticeFixture({ headline: "Back again" })], next_cursor: null }) },
    });
    renderHome();

    expect(alerts().querySelector("[aria-busy='true']")).not.toBeNull();
    const retry = await within(alerts()).findByRole("button", { name: "Try again" });
    expect(within(alerts()).getByText(/That doesn’t mean nothing happened/)).toBeInTheDocument();
    expect(within(alerts()).queryByText(RECENT_ALERTS_COPY.emptyTitle)).toBeNull();

    down = false;
    fireEvent.click(retry);
    expect(await within(alerts()).findByRole("link", { name: "Back again" })).toBeInTheDocument();
    expect(feedCalls(stub).length).toBeGreaterThanOrEqual(2);
  });

  it("loads older alerts beneath the ones shown, with the cursor the server gave", async () => {
    const stub = setup({
      notices: {
        respond: ({ path }) => (path.includes("cursor=c1")
          ? { items: [noticeFixture({ headline: "Older one" })], next_cursor: null }
          : { items: [noticeFixture({ headline: "Newest one" })], next_cursor: "c1" }),
      },
    });
    renderHome();

    fireEvent.click(await within(alerts()).findByRole("button", { name: RECENT_ALERTS_COPY.loadMore }));
    expect(await within(alerts()).findByRole("link", { name: "Older one" })).toBeInTheDocument();
    const names = within(alerts()).getAllByRole("link").map((a) => a.getAttribute("aria-labelledby") && a.textContent);
    expect(names[0]).toMatch(/Newest one/);
    expect(names[1]).toMatch(/Older one/);
    expect(feedCalls(stub).some((c) => c.path.includes("cursor=c1") && c.path.includes("limit=20"))).toBe(true);
    // The server said there is nothing older: the button goes.
    expect(within(alerts()).queryByRole("button", { name: RECENT_ALERTS_COPY.loadMore })).toBeNull();
  });

  it("an older page that fails leaves the rows standing and says so", async () => {
    setup({
      notices: {
        respond: ({ path }) => (path.includes("cursor=")
          ? refuse(400, { error: "cursor_invalid" })
          : { items: [noticeFixture({ headline: "Newest one" })], next_cursor: "stale" }),
      },
    });
    renderHome();

    fireEvent.click(await within(alerts()).findByRole("button", { name: RECENT_ALERTS_COPY.loadMore }));
    expect(await within(alerts()).findByText(RECENT_ALERTS_COPY.cursorExpired)).toBeInTheDocument();
    expect(within(alerts()).getByRole("link", { name: "Newest one" })).toBeInTheDocument();
  });

  it("is re-read by the Overview's own refresh", async () => {
    const stub = setup();
    renderHome();
    await within(alerts()).findByText(RECENT_ALERTS_COPY.emptyTitle);
    const before = feedCalls(stub).length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh overview" }));
    await waitFor(() => expect(feedCalls(stub).length).toBeGreaterThan(before));
  });
});
