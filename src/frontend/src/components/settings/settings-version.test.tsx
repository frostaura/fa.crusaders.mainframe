import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminSettingsPage from "../../pages/AdminSettings";
import { SETTINGS_FIXTURE, refuse, renderPage, stubFetch } from "../../test/harness";
import { SETTINGS_COPY } from "../../lib/settingsCopy";
import { control, findControl, saveButton } from "./testKit";

vi.setConfig({ testTimeout: 20_000 });

/**
 * Review round 4, A4-1 — a stale Settings tab put another admin's change back.
 *
 * <p>
 * The page PUT every key it shows, so saving a tab opened before a colleague's save reverted the
 * colleague's value (fault_spike_minutes 16 → 15, recorded as this admin's change). Against an
 * API that versions the document, the page now sends only what was edited plus the version it
 * was edited over; a stale save is answered 409 `settings_changed` with what is in force, and the
 * page shows theirs, keeps this admin's other edits on top and offers to put a clashing one back.
 * </p>
 */
const V1 = { ...SETTINGS_FIXTURE, version: "v1" };

describe("a versioned settings save (A4-1)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends only the edited key and the version it was edited over", async () => {
    const stub = stubFetch([
      { path: "/api/v1/admin/settings/", body: V1 },
      { path: "/api/v1/admin/courts/", body: [] },
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true, changed_keys: ["advance_booking_days"], version: "v2" } },
    ]);
    renderPage(<AdminSettingsPage />);
    fireEvent.change(await findControl(/Reserve window/), { target: { value: "30" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(true));
    const body = stub.calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    expect(body).toEqual({ version: "v1", advanceBookingDays: 30 });
    expect(await screen.findByText(SETTINGS_COPY.saved)).toBeInTheDocument();

    // The next save goes over the version the club answered with.
    fireEvent.change(control(/Reserve window/), { target: { value: "40" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(stub.calls.filter((c) => c.method === "PUT")[1].body).toEqual({ version: "v2", advanceBookingDays: 40 });
  });

  it("sends the whole weekday map when one day moved, and nothing else", async () => {
    const stub = stubFetch([
      { path: "/api/v1/admin/settings/", body: V1 },
      { path: "/api/v1/admin/courts/", body: [] },
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true, version: "v2" } },
    ]);
    renderPage(<AdminSettingsPage />);
    fireEvent.change(await findControl(/Reserve window/), { target: { value: "30" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(true));
    const body = stub.calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    expect(body.operatingHours).toBeUndefined();
    expect(body.sliceMinutes).toBeUndefined();
    expect(Object.keys(body).filter((key) => /slicePrice|creditsPerZar|topup(Block|Max)/i.test(key))).toEqual([]);
  });

  it("shows theirs after a stale save, keeps my other edit, and puts my clashing value back on request", async () => {
    // Somebody else set the reserve window to 21 days and the late-cancel window to 20 while this page was open.
    const theirs = { ...SETTINGS_FIXTURE, version: "v2", advance_booking_days: 21, penalty_window_minutes: 20 };
    const stub = stubFetch([
      { path: "/api/v1/admin/settings/", body: V1 },
      { path: "/api/v1/admin/courts/", body: [] },
      {
        method: "PUT", path: "/api/v1/admin/settings/",
        respond: (req) => ((req.body as { version?: string }).version === "v1"
          ? refuse(409, { error: "settings_changed", version: "v2", settings: theirs })
          : { saved: true, version: "v3" }),
      },
    ]);
    renderPage(<AdminSettingsPage />);
    fireEvent.change(await findControl(/Reserve window/), { target: { value: "30" } });
    fireEvent.change(control(/Court time per member per day/), { target: { value: "90" } });
    fireEvent.click(saveButton());

    expect(await screen.findByText(SETTINGS_COPY.conflictTitle)).toBeInTheDocument();
    expect(screen.getByText(/They changed Reserve window .* and Late-cancel window/)).toBeInTheDocument();
    expect(screen.getByText(/You both changed Reserve window/)).toBeInTheDocument();
    expect(screen.getByText(SETTINGS_COPY.conflictKept(1))).toBeInTheDocument();
    // Theirs on screen, mine on top where nobody clashed.
    expect(control(/Reserve window/)).toHaveValue(21);
    expect(control(/Late-cancel window/)).toHaveValue(20);
    expect(control(/Court time per member per day/)).toHaveValue(90);

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_COPY.conflictReapply(1) }));
    expect(control(/Reserve window/)).toHaveValue(30);
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    // Over THEIR version, and never their late-cancel window back to 15.
    expect(stub.calls.filter((c) => c.method === "PUT")[1].body).toEqual({
      version: "v2", advanceBookingDays: 30, memberPerDayMaxMinutes: 90,
    });
  });

  it("says an earlier press of ours landed when the only 'other' change is our own edit", async () => {
    stubFetch([
      { path: "/api/v1/admin/settings/", body: V1 },
      { path: "/api/v1/admin/courts/", body: [] },
      {
        method: "PUT", path: "/api/v1/admin/settings/",
        respond: () => refuse(409, { error: "settings_changed", version: "v2", settings: { ...SETTINGS_FIXTURE, version: "v2", advance_booking_days: 30 } }),
      },
    ]);
    renderPage(<AdminSettingsPage />);
    fireEvent.change(await findControl(/Reserve window/), { target: { value: "30" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(SETTINGS_COPY.savedAfterLostReply)).toBeInTheDocument();
    expect(screen.queryByText(SETTINGS_COPY.conflictTitle)).not.toBeInTheDocument();
  });

  it("still sends the whole page to an API that serves no version — without a retired money key it still serves", async () => {
    // An older API still serves the keys P13 retired (contract §3.9); the page shows none and sends none.
    const old = { ...SETTINGS_FIXTURE, slice_price_credits: 8, credits_per_zar_regular: 1.6, topup_block_zar: 100, topup_max_zar_per_member: 1000 };
    const stub = stubFetch([
      { path: "/api/v1/admin/settings/", body: old },
      { path: "/api/v1/admin/courts/", body: [] },
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
    ]);
    renderPage(<AdminSettingsPage />);
    fireEvent.change(await findControl(/Reserve window/), { target: { value: "30" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(true));
    const body = stub.calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    expect(body.sliceMinutes).toBe(15);
    expect(body.version).toBeUndefined();
    expect(Object.keys(body).filter((key) => /slice_?price|credits_?per_?zar|topup_?(block|max)/i.test(key))).toEqual([]);
  });
});
