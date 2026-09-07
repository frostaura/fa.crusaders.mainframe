/**
 * Is the rate the member is looking at still the rate the club just registered?
 *
 * <p>
 * `POST /credit/topup` answers with `conversion_rate` and `quoted_credits` — the figures the
 * pending row was actually written at — and `TopUp.tsx` used to throw both away and post
 * straight on to PayFast. The rate on screen comes from `GET /credit/topup/options`, fetched
 * once on mount and never revalidated, so anything that moved it in between (an admin editing
 * `credits_per_zar_*`, or that member's class changing) left the member paying R200 for the
 * 320 credits the server registered while the screen said 480, with the first appearance of
 * the real number being a ledger row. Three finders drove exactly that in round 3, twice each.
 * </p>
 *
 * <p>
 * Compared on the RATE, not on the credits: the credits are the rate times an amount this
 * function is not given, and a rate that has not moved cannot have moved them. A response
 * carrying no numeric rate — an older API, a proxy that mangled the body — is treated as
 * agreement rather than blocking a payment on a field the screen only reads.
 * </p>
 *
 * <p>
 * Its own module rather than an export beside the component: a page that exports a plain
 * function breaks React Fast Refresh for the whole file, and the pure half of a screen is
 * where the house keeps testable logic anyway (`bookingErrors.ts`, `scheduleGrid.ts`).
 * </p>
 */
export function rateMoved(quotedRate: number | undefined, registeredRate: unknown): boolean {
  if (typeof registeredRate !== "number" || !Number.isFinite(registeredRate)) return false;
  if (typeof quotedRate !== "number") return false;
  // Not `!==`. `credits_per_zar_*` carries four decimals, so any real difference is orders of
  // magnitude above float noise, and holding a member's payment over 1e-16 would be a bug of
  // its own.
  return Math.abs(registeredRate - quotedRate) > 1e-9;
}
