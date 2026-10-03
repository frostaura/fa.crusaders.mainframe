import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MY_CODE } from "../../../lib/myCodeCopy";
import { TOP_UP_LABEL } from "../../../lib/walletCopy";

const state = vi.hoisted(() => ({ balance: null as number | null, loading: true, held: null as null | { spendable: number } }));
vi.mock("../../../lib/useBalance", async (actual) => ({
  ...(await actual<typeof import("../../../lib/useBalance")>()),
  useBalance: () => state,
}));

const { WalletGlance } = await import("../WalletGlance");

const view = () => render(<MemoryRouter><WalletGlance /></MemoryRouter>, { reactStrictMode: true });

/** R4 form factor (SPEC 3.2): the wallet beside the pass — three states, never collapsed. */
describe("WalletGlance", () => {
  beforeEach(() => { Object.assign(state, { balance: null, loading: true, held: null }); });

  it("is a skeleton while the first figure is on its way", () => {
    const { container } = view();
    expect(screen.queryByRole("group", { name: MY_CODE.wallet.label })).toBeNull();
    expect(container.querySelector("[data-slot=skeleton], .animate-pulse")).not.toBeNull();
  });

  it("draws nothing when the balance could not be read — the chip says so, the code is the point", () => {
    Object.assign(state, { loading: false });
    const { container } = view();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the SPENDABLE figure, in minutes, and the way to buy more", () => {
    Object.assign(state, { balance: 120, loading: false, held: { spendable: 80 } });
    view();
    const group = screen.getByRole("group", { name: MY_CODE.wallet.label });
    expect(group).toHaveTextContent("1 h 20 min");
    expect(group).toHaveTextContent("1 hour 20 minutes");
    expect(group.textContent).not.toMatch(/credit|\bcr\b|\.\d/);
    expect(screen.getByRole("link", { name: TOP_UP_LABEL.fine })).toHaveAttribute("href", "/wallet/buy");
    expect(screen.getByRole("link", { name: new RegExp(MY_CODE.wallet.open) })).toHaveAttribute("href", "/wallet");
  });

  it("makes buying minutes the primary errand at zero", () => {
    Object.assign(state, { balance: 0, loading: false, held: null });
    view();
    expect(screen.getByRole("link", { name: TOP_UP_LABEL.zero })).toBeInTheDocument();
  });
});
