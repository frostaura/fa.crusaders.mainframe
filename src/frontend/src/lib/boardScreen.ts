import type { AdminDevice, AdminSettings, FirmwareRelease } from "./api";
import type { MegaDiagName } from "./deviceHealth";
import { asLayout, type LandingCourt } from "./landingPreview";

/**
 * How Boards resolves one board's screen from its own override and the club's setting
 * (device-api §5: absent or null is the club's, a value is the board's; compact on any doubt).
 */

/** What the club-wide settings say about screens, for a board with no override. */
export type ClubScreen = { layout: string | undefined; marquee: boolean | undefined; stepMs?: number; pageSeconds?: number };

/** What the Boards page knows beside the board list, all optional. */
export type BoardsContext = {
  releases: readonly FirmwareRelease[] | null;
  networkVer: number | null;
  keyId: string | null;
  nextKeyId: string | null;
  /** This board's courts' lights, in relay order, or null when the control board was not read. */
  courtsOf: (device: AdminDevice) => LandingCourt[] | null;
  timezone: string | undefined;
  club: ClubScreen;
  /** The page's clock tick, for the preview's wall clock (never Date.now() in a render). */
  now: number;
  /** The club's settings, for the hardware rows' club values and served enumerations. */
  settings: AdminSettings | null;
  /** How much each of this board's Mega counters rose since the page first read it. */
  risesOf: (device: AdminDevice) => Partial<Record<MegaDiagName, number>>;
};

/** The layout a board draws: its own override, else the club's, compact on any doubt. */
export function effectiveLayout(device: AdminDevice, club: ClubScreen): "compact" | "expanded" {
  return asLayout(device.lcd_layout ?? club.layout);
}

export function effectiveMarquee(device: AdminDevice, club: ClubScreen): boolean {
  if (typeof device.lcd_marquee_enabled === "boolean") return device.lcd_marquee_enabled;
  return club.marquee !== false;
}

/** Whether this API serves the v3 screen fields for a board at all. */
export function servesScreen(device: AdminDevice): boolean {
  return device.lcd_layout !== undefined || device.lcd_layout_acknowledged !== undefined;
}

