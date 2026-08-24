import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style className composer. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Credits, formatted for display.
 *
 * The unit of account is credits, not rand. A member tops up R100 and receives 160
 * credits at the Regular rate or 240 at the League/senior rate, and court prices are
 * quoted in credits — so rendering a credit balance with a rand sign is not a cosmetic
 * slip. At 1.6–2.4 credits per rand it overstates what a member has by 60% to 140%,
 * on the wallet header, the booking grid, the reports and the admin member list at once.
 *
 * That bug was live in six places. This function exists so there is one answer to
 * "how is money shown", and `formatZar` exists so the places that genuinely handle
 * rand can say so.
 */
export function formatCredits(value: number, options?: { long?: boolean }) {
  const amount = value.toFixed(2);
  return options?.long ? `${amount} credits` : `${amount} cr`;
}

/**
 * Rand, formatted for display.
 *
 * Only for amounts that really are rand: the top-up screens, where a member is paying
 * PayFast, and the admin reconciliation views. Everything else is credits.
 */
export function formatZar(value: number) {
  return `R${value.toFixed(2)}`;
}
