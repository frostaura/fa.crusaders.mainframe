import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import BuyMinutesPage from "./TopUp";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";
import { minutesShelf, openCheckout, purchaseStart } from "../test/minutesFixtures";
import { BUY_COPY } from "../lib/topUpShelf";

/**
 * BM-02 (go-live) — Back from PayFast restores /wallet/buy from the back-forward cache. The page
 * must not stay frozen as it left (Continue busy, nothing pressable): the restore frees the button
 * and reads the shelf again, so the checkout just started is listed with its own Cancel.
 */
const PURCHASE = "/api/v1/minutes/purchase";
const SHELF = "/api/v1/minutes/packages";

beforeEach(() => {
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
  vi.stubGlobal("EventSource", class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); sessionStorage.clear(); });

function pageshow(persisted: boolean) {
  const e = new Event("pageshow") as PageTransitionEvent;
  Object.defineProperty(e, "persisted", { value: persisted });
  window.dispatchEvent(e);
}

const continueButton = () => screen.getByRole("button", { name: new RegExp(BUY_COPY.cta) });

async function leaveForPayFast() {
  let started = false;
  const stub = stubFetch([
    { path: SHELF, respond: () => minutesShelf(started ? { open_checkouts: [openCheckout()] } : {}) },
    { method: "POST", path: PURCHASE, respond: () => { started = true; return purchaseStart(); } },
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
  ]);
  renderPage(<BuyMinutesPage />, { initialEntries: ["/wallet/buy"] });
  fireEvent.click(await screen.findByRole("radio", { name: "5 hours" }));
  fireEvent.click(continueButton());
  await waitFor(() => expect(HTMLFormElement.prototype.submit).toHaveBeenCalled());
  expect(continueButton()).toHaveAttribute("aria-busy", "true");
  return stub;
}

describe("Back from PayFast (BM-02)", () => {
  it("a back-forward restore frees Continue and lists the checkout just started", async () => {
    const stub = await leaveForPayFast();
    const reads = stub.calls.filter((c) => c.path === SHELF).length;
    await act(async () => { pageshow(true); });
    await waitFor(() => expect(continueButton()).not.toHaveAttribute("aria-busy", "true"));
    expect(stub.calls.filter((c) => c.path === SHELF).length).toBeGreaterThan(reads);
    expect(await screen.findByText(/waiting on PayFast/i)).toBeInTheDocument();
  });

  it("an ordinary pageshow (not from the cache) leaves the hand-off alone", async () => {
    const stub = await leaveForPayFast();
    const reads = stub.calls.filter((c) => c.path === SHELF).length;
    await act(async () => { pageshow(false); });
    await new Promise((r) => setTimeout(r, 50));
    expect(continueButton()).toHaveAttribute("aria-busy", "true");
    expect(stub.calls.filter((c) => c.path === SHELF).length).toBe(reads);
  });
});
