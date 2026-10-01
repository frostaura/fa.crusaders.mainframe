import type { LedgerEntryType, WalletResponse, WebAuthnCredentialRow } from "./api";

/**
 * The setup checklist on My Code (P8): four things a new member does once, each derived from a
 * real read rather than from having clicked through the wizard.
 *
 * <p>
 * <b>Three states, never two.</b> `done`, `todo`, and `unknown` for an item whose read failed —
 * a failed read rendered as "not done yet" tells a member who added a passkey yesterday that
 * they have not. The progress counts `done` only, and the card says how many it could check.
 * </p>
 *
 * <p>
 * <b>What each one is read from.</b>
 * </p>
 * <ul>
 *   <li><b>Passkey</b> — `GET /me/webauthn/credentials`, at least one row.</li>
 *   <li><b>Bought minutes</b> — a package bought (`TopUp`, through PayFast) or sold at the desk
 *   (`AdminTopUp`) in the wallet page read, or any minutes on the balance (a member the desk has
 *   given minutes to has time to book with, which is what the step is for). P13: this was the
 *   "top up" step; the ledger type names keep their old words (contract §2.5).</li>
 *   <li><b>First booking</b> — a `BookingCharge` or `LightsPurchase` in the same page. The page
 *   is the newest fifty movements; a member with more than fifty movements and none of them a
 *   booking is not a new member, and the balance rule covers the buying side of the same case.</li>
 *   <li><b>App installed</b> — running as the installed app, or `appinstalled` on this device.</li>
 * </ul>
 */

export type ChecklistItemId = "passkey" | "buy" | "booking" | "install";
export type ChecklistState = "done" | "todo" | "unknown";
export type ChecklistItem = { id: ChecklistItemId; state: ChecklistState };

/** How many wallet movements the checklist reads. */
export const CHECKLIST_WALLET_PAGE = 50;

const BOOKED: readonly LedgerEntryType[] = ["BookingCharge", "LightsPurchase"];
/** A package bought in the app, or sold at the desk. */
const BOUGHT: readonly LedgerEntryType[] = ["TopUp", "AdminTopUp"];

/** `undefined` = still reading; `null` = the read failed. */
export type ChecklistInput = {
  passkeys: WebAuthnCredentialRow[] | null | undefined;
  wallet: WalletResponse | null | undefined;
  installed: boolean;
};

function fromRead<T>(value: T | null | undefined, test: (v: T) => boolean): ChecklistState {
  if (value === null || value === undefined) return "unknown";
  return test(value) ? "done" : "todo";
}

export function deriveChecklist(input: ChecklistInput): ChecklistItem[] {
  const entries = (w: WalletResponse) => (Array.isArray(w.entries) ? w.entries : []);
  return [
    { id: "passkey", state: fromRead(input.passkeys, (rows) => Array.isArray(rows) && rows.length > 0) },
    {
      id: "buy",
      state: fromRead(input.wallet, (w) => w.balance_minutes > 0 || entries(w).some((e) => BOUGHT.includes(e.type))),
    },
    { id: "booking", state: fromRead(input.wallet, (w) => entries(w).some((e) => BOOKED.includes(e.type))) },
    { id: "install", state: input.installed ? "done" : "todo" },
  ];
}

export function checklistProgress(items: ChecklistItem[]): { done: number; total: number; allDone: boolean } {
  const done = items.filter((item) => item.state === "done").length;
  return { done, total: items.length, allDone: done === items.length };
}
