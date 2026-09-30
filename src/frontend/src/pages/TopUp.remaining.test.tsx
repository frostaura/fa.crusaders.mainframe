import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import TopUpPage from "./TopUp";
import { refuse, renderPage, signIn, signOut, stubFetch } from "../test/harness";
import { TOP_UP_LIMIT } from "../lib/walletCopy";
import { formatMoney } from "../lib/utils";

/**
 * R4 M4-2 — the member's running limit. `/credit/topup/options` says how much of the club's
 * per-member ceiling is left (`remaining_zar`), and the page ignored it: R500 and R1000 were
 * offered and "Max R1000" said to a member with R100 left, and the refusal after Continue said
 * only "more than the club's top-up limit".
 */
const OPTIONS = { block_zar: 100, min_zar: 100, max_zar: 1000, presets_zar: [100, 200, 500, 1000], conversion_rate: 1.6, rate_group: null };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

function render(options: Record<string, unknown>, extra: Parameters<typeof stubFetch>[0] = [], isAdmin = false) {
  const stub = stubFetch([
    ...extra,
    { path: "/api/v1/whoami", body: signIn({ isAdmin }) },
    { path: "/api/v1/credit/topup/options", body: { ...OPTIONS, ...options } },
  ]);
  renderPage(<TopUpPage />);
  return stub;
}

const radios = () => screen.getAllByRole("radio").map((r) => r.textContent);

describe("Top-up — what is left of the member's limit (M4-2)", () => {
  it("offers only the amounts still possible, and says how much is left", async () => {
    render({ already_zar: 700, remaining_zar: 300 });
    await screen.findByRole("radio", { name: "R100" });
    expect(radios()).toEqual(["R100", "R200"]);
    expect(screen.getByText(TOP_UP_LIMIT.limits(formatMoney(100), formatMoney(300), formatMoney(700), formatMoney(1000), formatMoney(100)))).toBeInTheDocument();
    // A typed amount over what is left gets the sentence with the figure, and no preview.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "500" } });
    expect(screen.getByText(TOP_UP_LIMIT.overRemaining(formatMoney(300), formatMoney(1000)))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to PayFast" })).toBeDisabled();
  });

  it("starts on an amount the member can take", async () => {
    render({ presets_zar: [500, 1000], already_zar: 900, remaining_zar: 100 });
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("100"));
  });

  it("offers no form once nothing is left, and says why", async () => {
    render({ already_zar: 1000, remaining_zar: 0 });
    expect(await screen.findByText(TOP_UP_LIMIT.reachedTitle)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue to PayFast" })).not.toBeInTheDocument();
  });

  it("takes the figures a refusal carries, so the field says how much is left", async () => {
    render({ already_zar: 0, remaining_zar: 1000 }, [
      { method: "POST", path: "/api/v1/credit/topup", respond: () => refuse(400, { error: "amount_exceeds_member_cap", max_zar: 1000, already_zar: 800, remaining_zar: 200 }) },
    ]);
    fireEvent.click(await screen.findByRole("radio", { name: "R500" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));
    expect(await screen.findByText(TOP_UP_LIMIT.overRemaining(formatMoney(200), formatMoney(1000)))).toBeInTheDocument();
    expect(radios()).toEqual(["R100", "R200"]);
  });

  it("leaves an admin on the per-payment maximum — the running limit does not apply to the desk", async () => {
    render({ already_zar: 900, remaining_zar: 100 }, [], true);
    await screen.findByRole("radio", { name: "R100" });
    await waitFor(() => expect(radios()).toEqual(["R100", "R200", "R500", "R1000"]));
  });
});
