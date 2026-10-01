import type { MinutesShelf, OpenCheckout, PurchaseStart, PurchaseStatus, ShelfPackage } from "../lib/api";

/**
 * P13 — the member's side of buying minutes, exactly as `docs/specs/minutes-and-packages.md`
 * §3.4 writes it. The default shelf is the seeded one (§4.6: 1 h R120, 5 h R550, 10 h R1000)
 * with the savings §4.3 computes for it — R50 (8%) and R200 (16%) — so a screen test can quote
 * the contract's own worked example. Typed by the console's declarations, so a renamed key
 * breaks the build rather than a screen.
 */

const AT = "2026-10-01T08:00:00Z";
const EXPIRES = "2026-10-01T09:00:00Z";

export const PACKAGE_IDS = {
  hour: "00000000-0000-0000-0000-0000000000a1",
  five: "00000000-0000-0000-0000-0000000000a5",
  ten: "00000000-0000-0000-0000-0000000000aa",
} as const;

export const PURCHASE_ID = "00000000-0000-0000-0000-0000000000b1";

/** One club package at list price, no discount. Override any key. */
export function shelfPackage(over: Partial<ShelfPackage> = {}): ShelfPackage {
  return {
    id: PACKAGE_IDS.five, name: "5 hours", minutes: 300, list_price_zar: 550, discount_bps: 0, price_zar: 550,
    saving_zar: 50, saving_pct: 8, source: "club", group: null, ...over,
  };
}

/** The seeded shelf, smallest first; the baseline (1 hour) never shows a saving. */
export function seededShelf(): ShelfPackage[] {
  return [
    shelfPackage({ id: PACKAGE_IDS.hour, name: "1 hour", minutes: 60, list_price_zar: 120, price_zar: 120, saving_zar: null, saving_pct: null }),
    shelfPackage(),
    shelfPackage({ id: PACKAGE_IDS.ten, name: "10 hours", minutes: 600, list_price_zar: 1000, price_zar: 1000, saving_zar: 200, saving_pct: 16 }),
  ];
}

/**
 * The same shelf at a 10% group discount (§4.3's second example): club prices drop, minutes do
 * not, the savings become R45 and R180 at the same percentages.
 */
export function discountedShelf(): MinutesShelf {
  const group = { id: "00000000-0000-0000-0000-0000000000c1", name: "League" };
  return {
    discount: { bps: 1000, group },
    packages: [
      shelfPackage({ id: PACKAGE_IDS.hour, name: "1 hour", minutes: 60, list_price_zar: 120, discount_bps: 1000, price_zar: 108, saving_zar: null, saving_pct: null }),
      shelfPackage({ discount_bps: 1000, price_zar: 495, saving_zar: 45, saving_pct: 8 }),
      shelfPackage({ id: PACKAGE_IDS.ten, name: "10 hours", minutes: 600, list_price_zar: 1000, discount_bps: 1000, price_zar: 900, saving_zar: 180, saving_pct: 16 }),
    ],
    open_checkouts: [],
  };
}

export function openCheckout(over: Partial<OpenCheckout> = {}): OpenCheckout {
  return { id: PURCHASE_ID, package_name: "5 hours", minutes: 300, amount_zar: 550, created_at: AT, expires_at: EXPIRES, ...over };
}

/** `GET /api/v1/minutes/packages` with no discount and nothing open. */
export function minutesShelf(over: Partial<MinutesShelf> = {}): MinutesShelf {
  return { discount: null, packages: seededShelf(), open_checkouts: [], ...over };
}

/** `POST /api/v1/minutes/purchase` 200 — the signed PayFast form. */
export function purchaseStart(over: Partial<PurchaseStart> = {}): PurchaseStart {
  return {
    purchase_id: PURCHASE_ID, checkout_id: PURCHASE_ID, redirect_url: "https://sandbox.payfast.co.za/eng/process",
    form_fields: [
      { name: "merchant_id", value: "10000100" },
      { name: "amount", value: "550.00" },
      { name: "item_name", value: "Crusaders - 5 hours (5 h)" },
    ],
    package: { id: PACKAGE_IDS.five, name: "5 hours", minutes: 300 }, amount_zar: 550, ...over,
  };
}

/** `GET /api/v1/minutes/purchase/{id}` (and its cancel return). Pending by default. */
export function purchaseStatus(over: Partial<PurchaseStatus> = {}): PurchaseStatus {
  return {
    id: PURCHASE_ID, status: "Pending", package_id: PACKAGE_IDS.five, package_name: "5 hours", minutes: 300,
    list_price_zar: 550, discount_bps: 0, amount_zar: 550, failure_code: null, created_at: AT, expires_at: EXPIRES, ...over,
  };
}
