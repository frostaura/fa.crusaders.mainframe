/**
 * P13-F1 STAND-IN — this file is deleted (contract §7.1). A booking costs its playing minutes,
 * so there is no viewer price left to work out. The one export below survives only because the
 * integrator-owned `lib/bookingsApi.ts` still imports it; the integrator's patch
 * (`p13-ask-F1-to-integrator.md`) removes that import, and this file goes with it.
 */
export function readPricesByCourt(_raw: unknown): ReadonlyMap<string, number> | null {
  return null;
}
