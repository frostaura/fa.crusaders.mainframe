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
