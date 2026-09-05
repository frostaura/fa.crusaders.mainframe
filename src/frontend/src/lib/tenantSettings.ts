/**
 * Small derivations from the club's own settings, kept out of the settings page.
 *
 * <p>
 * Both of these mirror a rule the API owns. That is a duplication worth having — the
 * admin is choosing a number and needs to know what it buys before they press Save, not
 * after a box has been dark for three minutes — but it is a duplication, so it lives in
 * one named place with the server constant it mirrors written down beside it, rather than
 * inline in a hint string where the next person to change the server has no chance of
 * finding it.
 * </p>
 */

/**
 * The floor under the offline threshold, in seconds.
 *
 * Mirrors <code>HeartbeatCadence.MinOfflineAfterSeconds</code>. A club on the 15-second
 * minimum interval must not be called offline after 45 seconds of ordinary jitter.
 */
export const OFFLINE_FLOOR_SECONDS = 180;

/** Mirrors <code>HeartbeatCadence.MissedBeatsBeforeOffline</code>. */
export const MISSED_BEATS_BEFORE_OFFLINE = 3;

/** Mirrors <code>HeartbeatCadence.MinSeconds</code> / <code>MaxSeconds</code> — the range a box honours. */
export const HEARTBEAT_MIN_SECONDS = 15;
export const HEARTBEAT_MAX_SECONDS = 300;

/** The interval a box will actually run at, given what the tenant asked for. */
export function effectiveHeartbeatSeconds(configured: number): number {
  if (!Number.isFinite(configured)) return HEARTBEAT_MIN_SECONDS;
  return Math.min(HEARTBEAT_MAX_SECONDS, Math.max(HEARTBEAT_MIN_SECONDS, Math.trunc(configured)));
}

/** How long a box may be silent before the Devices page calls it offline. */
export function offlineAfterSeconds(configured: number): number {
  return Math.max(OFFLINE_FLOOR_SECONDS, effectiveHeartbeatSeconds(configured) * MISSED_BEATS_BEFORE_OFFLINE);
}

/**
 * The offline threshold in the words a hint should use.
 *
 * The settings hint used to promise "three missed beats" flatly, which is true only above
 * 60 seconds; below that the floor takes over and an admin lowering the interval to catch
 * an outage sooner got exactly no improvement and no explanation.
 */
export function describeOfflineAfter(configured: number): string {
  const seconds = offlineAfterSeconds(configured);
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}

/**
 * The zones offered in the timezone picker.
 *
 * <p>
 * <code>Intl.supportedValuesOf("timeZone")</code> is the browser's own copy of the IANA
 * tzdb, which is exactly the free-tier dependency CLAUDE.md names — no hand-kept list to
 * go stale when a country moves its clocks. It is not in every runtime (jsdom does not
 * carry it), so a small fallback covers the zones a club in this product's markets would
 * pick, and the tenant's current value is always present whatever the runtime answered:
 * a select that silently dropped the saved zone would show the club the wrong one and
 * then save it.
 * </p>
 */
export function timezoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  let zones: string[] = [];
  try {
    zones = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  if (zones.length === 0) zones = [...FALLBACK_TIMEZONES];
  return zones.includes(current) ? zones : [current, ...zones];
}

const FALLBACK_TIMEZONES = [
  "Africa/Johannesburg", "Africa/Cairo", "Africa/Lagos", "Africa/Nairobi",
  "Europe/London", "Europe/Amsterdam", "Europe/Monaco", "Europe/Lisbon",
  "Asia/Dubai", "Asia/Singapore", "Australia/Sydney",
  "America/New_York", "America/Chicago", "America/Los_Angeles", "UTC",
] as const;
