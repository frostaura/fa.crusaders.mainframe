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
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true, changed_keys: ["topup_block_zar"], version: "v2" } },
    ]);
    renderPage(<AdminSettingsPage />);
    fireEvent.change(await findControl(/Top-up block/), { target: { value: "150" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(true));
    const body = stub.calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    expect(body).toEqual({ version: "v1", topupBlockZar: 150 });
    expect(await screen.findByText(SETTINGS_COPY.saved)).toBeInTheDocument();

    // The next save goes over the version the club answered with.
    fireEvent.change(control(/Top-up block/), { target: { value: "200" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(stub.calls.filter((c) => c.method === "PUT")[1].body).toEqual({ version: "v2", topupBlockZar: 200 });
  });

  it("sends the whole weekday map when one day moved, and nothing else", async () => {
    const stub = stubFetch([
      { path: "/api/v1/admin/settings/", body: V1 },
      { path: "/api/v1/admin/courts/", body: [] },
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true, version: "v2" } },
    ]);
    renderPage(<AdminSettingsPage />);
    fireEvent.change(await findControl(/Top-up block/), { target: { value: "150" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(true));
    const body = stub.calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    expect(body.operatingHours).toBeUndefined();
    expect(body.sliceMinutes).toBeUndefined();
    expect(body.slicePriceCredits).toBeUndefined();
  });

  it("shows theirs after a stale save, keeps my other edit, and puts my clashing value back on request", async () => {
    // Somebody else raised the top-up block to 120 and the cap to 1200 while this page was open.
    const theirs = { ...SETTINGS_FIXTURE, version: "v2", topup_block_zar: 120, topup_max_zar_per_member: 1200 };
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
    fireEvent.change(await findControl(/Top-up block/), { target: { value: "150" } });
    fireEvent.change(control(/Court time per member per day/), { target: { value: "90" } });
    fireEvent.click(saveButton());

    expect(await screen.findByText(SETTINGS_COPY.conflictTitle)).toBeInTheDocument();
    expect(screen.getByText(/They changed Top-up block .* and Top-up cap per member/)).toBeInTheDocument();
    expect(screen.getByText(/You both changed Top-up block/)).toBeInTheDocument();
    expect(screen.getByText(SETTINGS_COPY.conflictKept(1))).toBeInTheDocument();
    // Theirs on screen, mine on top where nobody clashed.
    expect(control(/Top-up block/)).toHaveValue(120);
    expect(control(/Top-up cap per member/)).toHaveValue(1200);
    expect(control(/Court time per member per day/)).toHaveValue(90);

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_COPY.conflictReapply(1) }));
    expect(control(/Top-up block/)).toHaveValue(150);
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    // Over THEIR version, and never their cap back to 1000.
    expect(stub.calls.filter((c) => c.method === "PUT")[1].body).toEqual({
      version: "v2", topupBlockZar: 150, memberPerDayMaxMinutes: 90,
    });
  });

  it("says an earlier press of ours landed when the only 'other' change is our own edit", async () => {
    stubFetch([
      { path: "/api/v1/admin/settings/", body: V1 },
      { path: "/api/v1/admin/courts/", body: [] },
      {
        method: "PUT", path: "/api/v1/admin/settings/",
        respond: () => refuse(409, { error: "settings_changed", version: "v2", settings: { ...SETTINGS_FIXTURE, version: "v2", topup_block_zar: 150 } }),
      },
    ]);
    renderPage(<AdminSettingsPage />);
    fireEvent.change(await findControl(/Top-up block/), { target: { value: "150" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(SETTINGS_COPY.savedAfterLostReply)).toBeInTheDocument();
    expect(screen.queryByText(SETTINGS_COPY.conflictTitle)).not.toBeInTheDocument();
  });

  it("still sends the whole page to an API that serves no version", async () => {
    const stub = stubFetch([
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      { path: "/api/v1/admin/courts/", body: [] },
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
    ]);
    renderPage(<AdminSettingsPage />);
    fireEvent.change(await findControl(/Top-up block/), { target: { value: "150" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(true));
    const body = stub.calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    expect(body.sliceMinutes).toBe(15);
    expect(body.version).toBeUndefined();
  });
});
