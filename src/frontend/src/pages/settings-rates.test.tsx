import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import AdminSettingsPage from "./AdminSettings";
import { SETTINGS_FIXTURE, renderPage, stubFetch } from "../test/harness";

/**
 * The credit-conversion rate fields, held to the one thing they exist for: expressing the
 * club's rate.
 *
 * <p>
 * A number input's valid values step from `min`, not from zero. With `min=0.01` and `step=0.1`
 * the valid set was 0.01, 0.11, … 1.51, 1.61 — so the club's own shipped rates, 1.6 and 2.4,
 * were both invalid, every round rate an admin would type was rejected, and the spinner arrows
 * turned 1.6 into 1.61. None of it was visible: Save is not a native submit, so the browser
 * never ran the validation it was failing, and the form saved the corrupted rate happily.
 * </p>
 *
 * <p>
 * This lives in its own file rather than in AdminSettings.test.tsx because it asks a different
 * question — not "is the field on the screen" but "can the field hold the number the business
 * runs on".
 * </p>
 */
describe("the credit-conversion rate fields", () => {
  afterEach(() => vi.unstubAllGlobals());

  const routes = () => [
    { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
    { path: "/api/v1/admin/courts/", body: [] },
  ];

  /** The two shipped rates, straight off the fixture the API answers with. */
  const RATES: [RegExp, number][] = [
    [/Credits per R1 — members/, SETTINGS_FIXTURE.credits_per_zar_regular],
    [/Credits per R1 — league/, SETTINGS_FIXTURE.credits_per_zar_league],
  ];

  it("accept the rates the club actually uses", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    await screen.findByLabelText(RATES[0][0]);

    for (const [label, rate] of RATES) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      expect(field).toHaveValue(rate);
      expect(field.validity.stepMismatch).toBe(false);
      expect(field.validity.valid).toBe(true);
    }
  });

  it("accept every round rate an admin would plausibly type", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    const field = (await screen.findByLabelText(RATES[0][0])) as HTMLInputElement;

    for (const rate of ["1.5", "1.6", "2", "2.4", "2.5", "3", "0.75"]) {
      field.value = rate;
      expect(field.validity.stepMismatch, `rate ${rate} was rejected`).toBe(false);
    }
  });

  it("step in cents, so the arrows cannot nudge the rate by a hundredth of nowhere", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    await screen.findByLabelText(RATES[0][0]);

    for (const [label] of RATES) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      // A rand rate has no unit smaller than a cent, and the step base is `min`, so `min` and
      // `step` have to agree or every round value falls between two valid ones.
      expect(field.step).toBe("0.01");
      expect(field.min).toBe("0.01");
    }
  });
});
