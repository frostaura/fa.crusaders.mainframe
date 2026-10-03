import type { WalletResponse } from "@/lib/api";
import { useBalance } from "@/lib/balance";
import { heldFrom, type HeldFigures } from "@/lib/liveBalance";
import { memberReads } from "@/lib/offline/memberReads";
import { useCachedRead, useDataOwner } from "@/lib/offline/useCachedRead";
import { heldPartsLine } from "@/lib/walletCopy";
import { useAuth } from "@/lib/auth";

/**
 * F1.11 — what the chip SHOWS: what the member can spend. It showed the whole balance (550) while
 * 50 was held for a partner, so a member saw 550 and was refused a 520 booking. With nothing held
 * or owed back the two are the same number and nothing changes; with something set aside the
 * figure is the spendable one and the name and title say what the rest is.
 */
export type ChipFigures = { shown: number | null; parted: boolean; held: number; owedBack: number; heldParts: string | null };

function chipFigures(balance: number | null, held: HeldFigures | null): ChipFigures {
  const heldMinutes = held && held.held > 0 ? held.held : 0;
  const owedBack = held && held.owedBack > 0 ? held.owedBack : 0;
  const parted = balance !== null && held !== null && (heldMinutes > 0 || owedBack > 0);
  // F4-18 — each held part with its own release, when there are two or more deadlines.
  return { shown: parted ? held!.spendable : balance, parted, held: heldMinutes, owedBack, heldParts: heldMinutes > 0 ? heldPartsLine(held?.parts) : null };
}

/**
 * P5-6 (review round 5) — while the session check is out (or the club cannot be reached), the
 * figure this phone kept for the member it confirmed: the wallet page's last read, drawn and never
 * re-asked here (the check gates it). Null when the live balance is in charge, or nothing was kept.
 */
type Kept = { balance: number; held: HeldFigures; at: number | null } | null;

/**
 * R8 X8-2 — why there is no figure while the club is not confirming the session: `offline` (it
 * could not be reached) or `answered` (busy, failing), once the check has come back and nothing of
 * the wallet is kept on this phone. Null while the check is still out (the skeleton stands then).
 */
export type NoFigure = "offline" | "answered" | null;

function useKeptFigures(waiting: boolean): { kept: Kept; none: NoFigure } {
  const kept = useCachedRead<WalletResponse>(waiting ? memberReads.wallet.key : null, memberReads.wallet.load, { whileChecking: false });
  const owner = useDataOwner();
  const wallet = kept.data;
  if (!waiting) return { kept: null, none: null };
  if (wallet && typeof wallet.balance_minutes === "number") {
    return { kept: { balance: wallet.balance_minutes, held: heldFrom(wallet), at: kept.readAt }, none: null };
  }
  // Settled with nothing: the check answered "can't confirm" and no read is out.
  const settled = owner.offline && !kept.loading;
  return { kept: null, none: settled ? (owner.unreachable ? "offline" : "answered") : null };
}

/**
 * The figure the chip shows and where it comes from: the live balance once the club has confirmed
 * the session, the kept one before (P5-6). Shared with the account menu, which shows it when the
 * chip has folded away at large text on a phone (V5-4).
 */
export function useChipBalance() {
  const live = useBalance();
  const auth = useAuth();
  const { kept, none } = useKeptFigures(auth.status !== "authenticated");
  const balance = kept ? kept.balance : live.balance;
  const held = kept ? kept.held : live.held;
  // X8-2: nothing kept and nothing coming is not "loading" — the chip says it has no figure.
  const loading = kept || none ? false : live.loading;
  // F1.11 (supersedes D11 §3a's "the figure stays the whole balance"): the figure is what can be
  // spent; the name and title say what is held for partners and owed back to them.
  return { live, kept, none, balance, held, loading, figures: chipFigures(balance, held) };
}

