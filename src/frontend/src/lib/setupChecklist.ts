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
 *   <li><b>Topped up</b> — a `TopUp` in the wallet page read, or any credit on the balance (a
 *   member an admin has credited has money to book with, which is what the step is for).</li>
 *   <li><b>First booking</b> — a `BookingCharge` or `LightsPurchase` in the same page. The page
 *   is the newest fifty movements; a member with more than fifty movements and none of them a
 *   booking is not a new member, and the balance rule covers the top-up side of the same case.</li>
 *   <li><b>App installed</b> — running as the installed app, or `appinstalled` on this device.</li>
 * </ul>
 */

export type ChecklistItemId = "passkey" | "topup" | "booking" | "install";
export type ChecklistState = "done" | "todo" | "unknown";
export type ChecklistItem = { id: ChecklistItemId; state: ChecklistState };

/** How many wallet movements the checklist reads. */
export const CHECKLIST_WALLET_PAGE = 50;

const BOOKED: readonly LedgerEntryType[] = ["BookingCharge", "LightsPurchase"];

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
      id: "topup",
      state: fromRead(input.wallet, (w) => w.balance_credits > 0 || entries(w).some((e) => e.type === "TopUp")),
    },
    { id: "booking", state: fromRead(input.wallet, (w) => entries(w).some((e) => BOOKED.includes(e.type))) },
    { id: "install", state: input.installed ? "done" : "todo" },
  ];
}

export function checklistProgress(items: ChecklistItem[]): { done: number; total: number; allDone: boolean } {
  const done = items.filter((item) => item.state === "done").length;
  return { done, total: items.length, allDone: done === items.length };
}
