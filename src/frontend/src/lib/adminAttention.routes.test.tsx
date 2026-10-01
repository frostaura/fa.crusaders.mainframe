import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useNavigate } from "react-router-dom";
import { useAdminAttention } from "./adminAttention";
import { notifyPendingApplicationsChanged } from "./pendingApplications";
import { memberFixture, renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * R4 perf: the admin console re-read all three attention counts on EVERY move between sections
 * (the store's read effect was keyed on the route). A move now re-reads only counts older than
 * the fresh window; arriving, an application changing, the minute poll and a return to the tab
 * still read.
 */
function Probe() {
  const attention = useAdminAttention({ enabled: true });
  const go = useNavigate();
  return (
    <>
      <p>{`pending ${attention.pending}`}</p>
      <button type="button" onClick={() => go("/admin/members")}>Members</button>
      <button type="button" onClick={() => go("/admin/settings")}>Settings</button>
    </>
  );
}

describe("attention counts across admin routes", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  it("does not re-read the counts on every move between sections", async () => {
    signIn({ isAdmin: true });
    const stub = stubFetch([
      { path: "/api/v1/admin/members", body: [memberFixture({ status: "PendingApproval" })] },
      { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
      { path: "/api/v1/admin/play/results/disputed-count", body: { count: 0 } },
      { path: "/api/v1/admin/doors", body: { doors: [], signals: [] } },
    ]);
    renderPage(<Probe />, { initialEntries: ["/admin"] });
    expect(await screen.findByText("pending 1")).toBeInTheDocument();
    const reads = () => stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/monitoring/summary")).length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    const before = reads();

    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(reads()).toBe(before);
  });
});

/**
 * R5 P5: a cold Members page read the pending count three times — once for the shell's badge,
 * once more as the rail arrived a moment later, and again because the members list had landed.
 */
describe("attention counts on a cold Members page (R5 P5)", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  function Second() {
    const [shown, setShown] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setShown(true)}>Rail</button>
        {shown ? <Probe /> : null}
      </>
    );
  }

  it("reads once for every reader, and takes the list's own count instead of asking again", async () => {
    signIn({ isAdmin: true });
    const stub = stubFetch([
      { path: "/api/v1/admin/members", body: [memberFixture({ status: "PendingApproval" })] },
      { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
      { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
      { path: "/api/v1/admin/doors", body: { doors: [], signals: [] } },
    ]);
    renderPage(<><Probe /><Second /></>, { initialEntries: ["/admin/members"] });
    expect(await screen.findByText("pending 1")).toBeInTheDocument();
    const reads = () => stub.calls.filter((c) => c.path.includes("status=PendingApproval")).length;
    await waitFor(() => expect(reads()).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Rail" }));
    await act(async () => { notifyPendingApplicationsChanged(4); });
    await waitFor(() => expect(screen.getAllByText("pending 4")).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(reads()).toBe(1);
  });
});
