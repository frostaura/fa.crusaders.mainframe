import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MonitoringFaultsPage, groupByBoard } from "./MonitoringFaults";
import { renderPage, signIn, stubFetch, unreachable, type StubRoute } from "../../test/harness";
import { deviceErrorFixture, deviceErrorPageFixture } from "../../test/monitoringFixtures";
import { NOTHING_CHANGED } from "../../components/Toast";
import type { DeviceErrorRow } from "../../lib/adminApi";

/**
 * The fault list — GOAL item 7.
 *
 * <p>
 * Two properties carry this page and both are about what it refuses to claim. It must never
 * render an empty list over a failed read, because "no faults" and "we could not ask" are
 * different answers and only one of them means an admin can go home. And it must never let a
 * control mean something quieter than its word: D2's wire has one verb, `resolve`, with no
 * server-side guard on resolving a fault that is still happening, so the page says what
 * resolving actually does rather than implying a repair.
 * </p>
 */

const routes = (rows: DeviceErrorRow[] | null, extra: StubRoute[] = []): StubRoute[] => [
  { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
  ...(rows ? [{ path: "/api/v1/admin/monitoring/errors", body: deviceErrorPageFixture(rows) } as StubRoute] : []),
  ...extra,
];

describe("grouping, which is the shape of the trip somebody makes with this page", () => {
  it("groups by board, because an admin walks to a board and not to an error code", () => {
    const groups = groupByBoard([
      deviceErrorFixture({ id: "a", device_id: "d1", device_name: "Box 1-4" }),
      deviceErrorFixture({ id: "b", device_id: "d2", device_name: "Front door" }),
      deviceErrorFixture({ id: "c", device_id: "d1", device_name: "Box 1-4" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.name === "Box 1-4")!.rows).toHaveLength(2);
  });

  /**
   * An authentication failure has no device row BY DEFINITION — that is the whole of what it
   * is reporting. Dropping it, or filing it under a board that did not report it, loses the
   * one fault that means somebody has the club's key.
   */
  it("keeps a fault that belongs to no board, under a name that says so", () => {
    const groups = groupByBoard([
      deviceErrorFixture({ id: "a", device_id: null, device_name: null, code: "auth_failed" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Not from a board the club knows");
  });

  it("puts the board that spoke most recently first", () => {
    const groups = groupByBoard([
      deviceErrorFixture({ id: "a", device_id: "d1", device_name: "Old", last_seen_at: "2026-09-20T10:00:00Z" }),
      deviceErrorFixture({ id: "b", device_id: "d2", device_name: "New", last_seen_at: "2026-09-22T10:00:00Z" }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["New", "Old"]);
  });
});

describe("the fault list", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  it("says what a fault means and what to do about it, not just its code", async () => {
    stubFetch(routes([deviceErrorFixture()]));
    renderPage(<MonitoringFaultsPage />);

    expect(await screen.findByText("The scanner stopped answering")).toBeInTheDocument();
    expect(screen.getByText(/Nobody can scan a code at this box/)).toBeInTheDocument();
    expect(screen.getByText(/Check the scanner's cable/)).toBeInTheDocument();
  });

  it("shows severity as a word as well as a tone", async () => {
    stubFetch(routes([deviceErrorFixture({ severity: "warning" })]));
    renderPage(<MonitoringFaultsPage />);
    // Under forced colours the chip's fill is discarded and this is all that survives.
    expect(await screen.findByText("Works, but worse")).toBeInTheDocument();
  });

  it("shows the three numbers that separate a one-off from a fire", async () => {
    stubFetch(routes([deviceErrorFixture({ count: 47 })]));
    renderPage(<MonitoringFaultsPage />);
    expect(await screen.findByText(/47 times · first Sun 20 Sept, 18:02 · last/)).toBeInTheDocument();
  });

  /**
   * <b>The trap this whole surface sits inside.</b> A list initialised to `[]` renders its
   * empty state on a read that FAILED, so the screen says "no faults" when what happened is
   * "we could not ask" — and an admin goes home.
   */
  it("never says there are no faults when what happened is that it could not ask", async () => {
    stubFetch(routes(null, [
      { path: "/api/v1/admin/monitoring/errors", status: 500, body: { error: "boom" } },
    ]));
    renderPage(<MonitoringFaultsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/That does not mean there are none/);
    expect(screen.queryByText(/No faults/), "an empty state over a failed read").not.toBeInTheDocument();
  });

  it("says the good empty, with what it is an absence of", async () => {
    stubFetch(routes([]));
    renderPage(<MonitoringFaultsPage />);
    expect(await screen.findByText(/No faults in the last 90 days/)).toBeInTheDocument();
  });

  /**
   * The control that would otherwise quietly mean something else. There is no acknowledge
   * endpoint on the wire, so there is no acknowledge control — and resolving is a note
   * somebody wrote, not a repair the software performed.
   */
  it("says what resolving does, and does not offer an acknowledge that does not exist", async () => {
    stubFetch(routes([deviceErrorFixture()]));
    renderPage(<MonitoringFaultsPage />);
    await screen.findByText("The scanner stopped answering");

    // Twice on purpose: the visible banner and the region that speaks it once.
    expect(screen.getAllByText(/It does not stop the fault/).length).toBeGreaterThan(0);
    const controls = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(controls.some((t) => /acknowledge/i.test(t)), "a verb the wire has no endpoint for").toBe(false);
  });

  it("arms the resolve and states the consequence before the second press", async () => {
    const stub = stubFetch(routes([deviceErrorFixture()], [
      { method: "POST", path: "/api/v1/admin/monitoring/errors/e1/resolve", body: deviceErrorFixture({ resolved_at: "2026-09-22T17:00:00Z" }) },
    ]));
    renderPage(<MonitoringFaultsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Mark resolved/ }));
    // The armed control states the consequence in the page, and its NAME carries the fault
    // it is about plus the "choose again" state — a list of controls all reading "Mark
    // resolved" is nothing at all to somebody tabbing through them.
    // Twice: the visible consequence and ConfirmButton's own live region.
    expect((await screen.findAllByText(/comes back if the board reports it again/)).length).toBeGreaterThan(0);
    const armed = screen.getByRole("button", { name: /The scanner stopped answering — choose again to confirm/ });
    fireEvent.click(armed);

    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path.includes("/resolve"))).toBe(true));
  });

  /**
   * <b>`unchanged` only where it is KNOWN.</b> A 4xx is the server refusing before it wrote,
   * so the page may say nothing changed. A network failure may have been applied and the
   * answer lost coming back, and claiming otherwise there is worse than saying nothing.
   */
  it("says nothing changed for a refusal, and does not say it for a lost connection", async () => {
    const stub = stubFetch(routes([deviceErrorFixture()], [
      { method: "POST", path: "/api/v1/admin/monitoring/errors/e1/resolve", status: 409, body: { error: "already_resolved" } },
    ]));
    renderPage(<MonitoringFaultsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Mark resolved/ }));
    fireEvent.click(await screen.findByRole("button", { name: /choose again to confirm/ }));

    expect(await screen.findByText(NOTHING_CHANGED)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path.includes("/resolve"))).toBe(true);
  });

  /**
   * The other half, and the half a mutation found missing: a request that never got an
   * answer may have been applied. Saying "nothing changed" there is the one failure worse
   * than saying nothing at all, because an admin would go and resolve it again.
   */
  it("will not claim nothing changed when the answer was simply lost", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/monitoring/errors", body: deviceErrorPageFixture([deviceErrorFixture()]) },
      unreachable("/api/v1/admin/monitoring/errors/e1/resolve", "POST"),
    ]);
    renderPage(<MonitoringFaultsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Mark resolved/ }));
    fireEvent.click(await screen.findByRole("button", { name: /choose again to confirm/ }));

    expect(await screen.findByText(/Couldn't reach the club/)).toBeInTheDocument();
    expect(screen.queryByText(NOTHING_CHANGED), "a claim about a write nobody saw land")
      .not.toBeInTheDocument();
  });

  it("reports a batch as a screen with one row per item, never as a toast", async () => {
    stubFetch(routes(
      [deviceErrorFixture({ id: "e1" }), deviceErrorFixture({ id: "e2", code: "relay_fault", headline: "Relay D didn't answer" })],
      [{
        method: "POST",
        path: "/api/v1/admin/monitoring/errors/resolve-bulk",
        body: {
          requested: 2, succeeded: 1, failed: 1,
          results: [
            { id: "e1", status: "resolved" },
            { id: "e2", status: "already_resolved" },
          ],
        },
      }],
    ));
    renderPage(<MonitoringFaultsPage />);

    const boxes = await screen.findAllByRole("checkbox");
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(await screen.findByRole("button", { name: /Mark 2 resolved/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Mark all 2 resolved/ }));

    // Four seconds is not enough to read two outcomes, and the toast viewport carries no
    // live region of its own by design.
    expect(await screen.findByText("1 of 2 done.")).toBeInTheDocument();
    expect(screen.getByText(/Somebody else marked this one resolved/)).toBeInTheDocument();
  });

  it("renders a code it has never heard of, with the raw code still reachable", async () => {
    stubFetch(routes([deviceErrorFixture({
      code: "flux_capacitor_drift", headline: null, detail: "coil at 88mph",
    })]));
    renderPage(<MonitoringFaultsPage />);

    // A feed that silently drops rows is a feed an admin cannot reason about — and losing the
    // raw token would make the humanised row unsearchable for whoever reports it upstream.
    expect(await screen.findByText(/does not have a name for/)).toBeInTheDocument();
    expect(screen.getByText("flux_capacitor_drift")).toBeInTheDocument();
  });

  it("keeps a resolved fault readable rather than merely filtering it away", async () => {
    stubFetch(routes([deviceErrorFixture({
      resolved_at: "2026-09-22T05:15:00Z",
      resolved_by_name: "Priya Naidoo",
      resolution_note: "replaced the scanner",
    })]));
    renderPage(<MonitoringFaultsPage />);

    expect(await screen.findByText(/Marked resolved by Priya Naidoo at Tue 22 Sept, 07:15\. "replaced the scanner"/))
      .toBeInTheDocument();
    // Nothing to resolve twice.
    expect(screen.queryByRole("button", { name: /Mark resolved/ })).not.toBeInTheDocument();
  });
});
