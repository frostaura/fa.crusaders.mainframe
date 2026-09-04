import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminSettingsPage from "./AdminSettings";
import { SETTINGS_FIXTURE, renderPage, stubFetch } from "../test/harness";

/**
 * The settings screen.
 *
 * <p>
 * Nine keys the engine has always read were editable only by hand-editing a JSON column
 * on a live money system — conversion rates, top-up caps, the per-day limit, peak hours,
 * retention. They are on the screen now, and these tests hold two things: that they are
 * actually there, and that saving them does not revert a button remap made from the
 * devices page.
 * </p>
 *
 * <p>
 * That second one is the interesting failure. The API reads an absent key as unchanged,
 * so two screens editing one document only work if each omits what it does not own.
 * </p>
 */
describe("AdminSettings", () => {
  afterEach(() => vi.unstubAllGlobals());

  const routes = () => [
    { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
    { path: "/api/v1/admin/courts/", body: [] },
  ];

  it("shows the economics keys that used to need a database client", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByLabelText(/Credits per R1 — members/)).toHaveValue(1.6);
    expect(screen.getByLabelText(/Credits per R1 — league/)).toHaveValue(2.4);
    expect(screen.getByLabelText(/Top-up block/)).toHaveValue(100);
    expect(screen.getByLabelText(/Top-up cap per member/)).toHaveValue(1000);
    expect(screen.getByLabelText(/Court time per member per day/)).toHaveValue(60);
    expect(screen.getByLabelText(/^Peak hours/)).toHaveValue("16:00-19:00");
    expect(screen.getByLabelText(/Peak opens to everyone/)).toHaveValue(1);
    expect(screen.getByLabelText(/Keep usage history/)).toHaveValue(2);
    expect(screen.getByLabelText(/No-show sweep looks back/)).toHaveValue(7);
  });

  it("sends an edited economics value and leaves the button map alone", async () => {
    const stub = stubFetch([
      ...routes(),
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
    ]);

    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Credits per R1 — league/), { target: { value: "2.8" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const save = stub.calls.find((c) => c.method === "PUT");
      expect(save).toBeTruthy();
      const body = save!.body as Record<string, unknown>;

      expect(body.creditsPerZarLeague).toBe(2.8);

      // The button map is the devices page's business. Sending a stale copy from here
      // would silently undo a remap somebody made there — and the API cannot tell the
      // difference between "unchanged" and "changed back".
      expect(body).not.toHaveProperty("buttonMap");
    });
  });

  it("shows the six court-box numbers and sends them back on save", async () => {
    const stub = stubFetch([
      ...routes(),
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
    ]);

    renderPage(<AdminSettingsPage />);

    // Served by GET /admin/settings since the programme added them, and until now
    // absent from this page — an admin could see none of them and change none of them.
    expect(await screen.findByLabelText(/Walk-up maximum/)).toHaveValue(90);
    expect(screen.getByLabelText(/Heartbeat interval/)).toHaveValue(60);
    expect(screen.getByLabelText(/Activation window before a booking/)).toHaveValue(120);
    expect(screen.getByLabelText(/Lights cue before a booking/)).toHaveValue(10);
    expect(screen.getByLabelText(/Court code lifetime/)).toHaveValue(60);
    expect(screen.getByLabelText(/Offline roster reach/)).toHaveValue(120);

    // The API's bounds, on the inputs, so the form cannot offer a value the save refuses.
    expect(screen.getByLabelText(/Walk-up maximum/)).toHaveAttribute("max", "90");
    expect(screen.getByLabelText(/Heartbeat interval/)).toHaveAttribute("min", "10");
    expect(screen.getByLabelText(/Court code lifetime/)).toHaveAttribute("min", "15");
    // The cue must fit inside the forward window; the cap follows the window's value.
    expect(screen.getByLabelText(/Lights cue before a booking/)).toHaveAttribute("max", "120");

    fireEvent.change(screen.getByLabelText(/Court code lifetime/), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText(/Walk-up maximum/), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const save = stub.calls.find((c) => c.method === "PUT");
      expect(save).toBeTruthy();
      const body = save!.body as Record<string, unknown>;
      // The edited two, changed; the other four, round-tripped as read. The save
      // mapper used to strip all six, so a save from here reset none — and changed none.
      expect(body).toMatchObject({
        qrLifetimeSeconds: 45,
        walkUpMaxMinutes: 60,
        heartbeatSeconds: 60,
        activationForwardWindowMinutes: 120,
        activationCueWindowMinutes: 10,
        rosterWindowMinutes: 120,
      });
    });
  });

  it("prices courts in credits, not rand", async () => {
    stubFetch([
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      { path: "/api/v1/admin/courts/", body: [{ id: "c1", court_number: 1, name: "Court 1", court_type: "Squash", slice_price_credits: 8, is_active: true }] },
    ]);

    renderPage(<AdminSettingsPage />);

    // A court's slice price is what a member is CHARGED, in credits — the unit of
    // account. The field was labelled "(R)", so the admin priced courts in the wrong unit.
    expect(await screen.findByLabelText(/Price per slice \(credits\)/)).toBeInTheDocument();
    expect(screen.getByLabelText("Court 1 price per slice (credits)")).toHaveValue(8);
    expect(screen.queryByLabelText(/Price per slice \(R\)/)).not.toBeInTheDocument();
  });

  it("shows the API's reason when a value is refused", async () => {
    stubFetch([
      ...routes(),
      { method: "PUT", path: "/api/v1/admin/settings/", status: 400, body: { error: "topup_max_below_block" } },
    ]);

    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Top-up cap per member/), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    // A cap below the block size means no top-up is ever legal, which reads to a member
    // as the payment page being broken. The admin has to be told which value, not just
    // that something failed.
    expect(await screen.findByText(/topup max below block/)).toBeInTheDocument();
  });
});
