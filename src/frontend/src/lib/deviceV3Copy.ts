import { ApiError, deviceCaps, type AdminDevice, type DeviceKeyBoard } from "./api";
import { RELAYS } from "./buttonMap";
import { clubDayAndClock } from "./clubClock";
import { mcusrWords } from "./deviceHealth";

/**
 * The words the Boards page says about the device contract v3 (device-api §6, §8, §10): key
 * rotation, the club network, each board's screen and versions. One module, so a sentence a test
 * pins is written once and the panels only lay it out.
 */

/** Where the keyboard lands once the key has changed (a rotation, a retirement, a restore). */
export const DEVICE_KEY_LINE_ID = "device-api-key-line";

/** "18:05 today", "Thu 13 Nov, 18:05" — or the raw text when it is not a date. */
export function at(iso: string | null | undefined): string {
  if (!iso) return "an unknown time";
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : clubDayAndClock(when);
}

/** "A: court 1, B: court 2" — the relay bank as an admin reads it off the box. */
export function describeRelayCourts(courtNumbers: readonly number[]): string {
  if (courtNumbers.length === 0) return "no courts";
  return courtNumbers.map((n, i) => `${RELAYS[i]}: court ${n}`).join(", ");
}

/** A board, named the way an admin finds it on Boards. */
export function boardName(board: Pick<DeviceKeyBoard, "name" | "device_code"> & { id?: string }): string {
  return board.name?.trim() || board.device_code || board.id || "a board";
}

/** "box-a1", "box-a1 and gate-b2", "box-a1, box-c3 and gate-b2". */
export function listBoards(boards: readonly Pick<DeviceKeyBoard, "name" | "device_code">[]): string {
  const names = boards.map(boardName);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------
// Key rotation (§6)
// ---------------------------------------------------------------------------------------

/** Does what the admin typed match one of the API's confirmation phrases (trimmed, case-blind, like the API)? */
export function typedPhrase(typed: string, phrase: string): boolean {
  return typed.trim().toLowerCase() === phrase.toLowerCase();
}

export const KEY_COPY = {
  rotateTitle: "Rotate the club's device key?",
  rotate: "A new key is made and the current one keeps working. Every board that can rotate picks the new key up "
    + "the next time it calls in; nothing is reflashed. The old key is retired by itself once every board has the new "
    + "one and the grace time has passed — never while a board that cannot rotate is still in service.",
  rotated: (id: string) => `Rotation started: key ${id} is being handed to the boards. The old key still works.`,
  rotateStill: "the key is as it was",
  rotateWhether: "a rotation started",
  inProgress: "A rotation is already under way — it is shown below.",
  retireTitle: "Retire the old key now?",
  /**
   * What the admin types to retire the old key, and to restore one: the API's own phrases
   * (`DeviceKeyRing.RetirePhrase` / `RestorePhrase`, compared trimmed and case-blind), pinned against
   * the server source by `deviceKeyPhrases.contract.test.ts`.
   */
  retirePhrase: "retire the old key",
  retire: "Every board still on the old key stops reaching the club the moment it is retired, and a "
    + "board that cannot rotate can then be fixed only with a cable. Retire it only if it has leaked.",
  retireType: 'Type "retire the old key" to confirm',
  retireNotReady: 'Type "retire the old key" to confirm.',
  retireLabel: "Retire the old key",
  retired: "The old key is retired. Boards on it can no longer reach the club.",
  stranded: (boards: string) => `These boards would be cut off: ${boards}.`,
  restoreTitle: "Put back a key the boards already hold?",
  restore: "After the club's database is lost or rebuilt, the boards still hold the key they had. Paste it here to make "
    + "it the club's current key again, so they can call in. Only the club's owner can do this; the key is never shown "
    + "again after it is saved.",
  restoreWord: "restore this key",
  restoreNotReady: 'Paste the 43-character key and type "restore this key" to confirm.',
  restoreKeyInvalid: "A device key is exactly 43 letters, digits, - and _.",
  restored: "Key restored. Boards holding it can call in again.",
  ownerOnly: "Only the club's owner can restore a key.",
};

/** One rotation's state, in a line. */
export function rotationLine(nextId: string, startedAt: string, counts: { onNew: number; onOld: number; cannot: number }): string {
  const parts = [`${plural(counts.onNew, "board")} on the new key`];
  if (counts.onOld > 0) parts.push(`${plural(counts.onOld, "board")} still on the old one`);
  if (counts.cannot > 0) parts.push(`${plural(counts.cannot, "board")} that cannot rotate`);
  return `Rotating to key ${nextId} since ${at(startedAt)}: ${parts.join(", ")}.`;
}

/** When the old key goes, or why it will not go by itself. */
export function retirementLine(graceEndsAt: string | null, cannot: number, onOld: number): string {
  if (cannot > 0) {
    return `The old key will not be retired by itself while ${plural(cannot, "board")} that cannot rotate `
      + `${cannot === 1 ? "is" : "are"} in service. Flash ${cannot === 1 ? "it" : "them"} to the current firmware, or take `
      + `${cannot === 1 ? "it" : "them"} out of service.`;
  }
  if (graceEndsAt) return `The old key retires by itself at ${at(graceEndsAt)}.`;
  if (onOld > 0) return "The old key retires by itself once every board has the new one and the grace time has passed.";
  return "Every board has the new key. The old one retires by itself when the grace time has passed.";
}

/** Each board's key, in words (§6 "Track"). */
export function boardKeyLine(device: AdminDevice, currentId: string | null | undefined, nextId: string | null | undefined): string | null {
  const caps = deviceCaps(device);
  if (!caps.has("key:1")) return device.key_id === undefined ? null : "Key: cannot rotate (needs the current firmware)";
  if (!device.key_id) return null;
  if (nextId && device.key_id === nextId) return `Key: ${device.key_id}, the new one`;
  if (nextId && device.key_id !== nextId) return `Key: still on ${device.key_id}`;
  if (currentId && device.key_id === currentId) return `Key: ${device.key_id}`;
  return `Key: ${device.key_id}`;
}

// ---------------------------------------------------------------------------------------
// Each board: screen, versions, network (§2, §5, §8)
// ---------------------------------------------------------------------------------------

export const LAYOUT_WORD: Readonly<Record<string, string>> = { compact: "compact 16×2", expanded: "expanded 20×4" };

/** What the glass is doing against what was asked: "Showing expanded 20×4 since 18:05". */
export function screenLine(device: AdminDevice, asked: string): string {
  const shown = device.lcd_layout_acknowledged;
  const askedWord = LAYOUT_WORD[asked] ?? asked;
  if (!shown) {
    return deviceCaps(device).has("lcd:2")
      ? `Asked for ${askedWord}; the box has not confirmed a layout since it last restarted.`
      : "Screen: compact 16×2 — this box's firmware cannot change layout.";
  }
  const shownWord = LAYOUT_WORD[shown] ?? shown;
  if (shown === asked) return `Showing ${shownWord} since ${at(device.lcd_layout_acknowledged_at)}.`;
  return `Asked for ${askedWord}, but the box still shows ${shownWord} (since ${at(device.lcd_layout_acknowledged_at)}).`
    + " It changes the next time it calls in.";
}

/**
 * The firmware line: the version the board last reported running. The boards have no remote
 * update (device-api §7): a firmware change is a cable flash.
 */
export function firmwareLine(device: AdminDevice): string | null {
  return device.running_version ? `Firmware ${device.running_version}` : null;
}

/** The Mega's version and its last reset cause (`mega.reset`, the `MCUSR` it sent in `!BOOT`). */
export function megaLine(device: AdminDevice): string | null {
  const reset = device.mega?.reset;
  if (!device.mega_version && !reset) return null;
  const cause = mcusrWords(reset);
  const parts = [device.mega_version ? `Mega ${device.mega_version}` : "Mega"];
  if (cause) parts.push(`last restart: ${cause}`);
  return parts.join(" · ");
}

const NET_SRC_WORDS: Readonly<Record<string, string>> = {
  local: "set at the box itself", compiled: "what it was flashed with", server: "from the club",
};

/** Whether this board is behind the club's network version (a `local` board keeps its own). */
function networkBehind(device: AdminDevice, clubVer: number | null): boolean {
  if (clubVer === null || typeof device.net_ver !== "number" || device.net_src === "local") return false;
  return device.net_ver < clubVer;
}

/** The network line: the version applied and where it came from. */
export function networkLine(device: AdminDevice, clubVer: number | null): string | null {
  if (device.net_ver === undefined && device.net_src === undefined) return null;
  const src = device.net_src ? NET_SRC_WORDS[device.net_src] ?? null : null;
  const ver = typeof device.net_ver === "number" ? `network version ${device.net_ver}` : "network";
  const from = src ? " (" + src + ")" : "";
  const behind = networkBehind(device, clubVer) ? `, the club's is ${clubVer} — it updates the next time it calls in` : "";
  return ver + from + behind;
}

// ---------------------------------------------------------------------------------------
// The club network (§8)
// ---------------------------------------------------------------------------------------

export const NETWORK_COPY = {
  lede: "The WiFi the boards join and the address they call. A change reaches every board the next time it calls in"
    + " — no cable, no visit.",
  calls: (base: string) => `The boards call ${base}.`,
  noBase: "No server address is saved yet: the boards use the one they were flashed with.",
  noWifi: "No WiFi is saved yet: the boards use the network they were flashed with.",
  profile: (i: number, ssid: string, pskSet: boolean) =>
    `${i === 0 ? "First" : "Second"} WiFi: ${ssid}${pskSet ? " (password saved)" : " (open network)"}`,
  version: (ver: number) => `Network version ${ver}.`,
  savedAt: (when: string, by: string | null) => `Saved ${when}${by ? ` by ${by}` : ""}.`,
  behind: (names: string[]) => `Not on it yet: ${listNames(names)}. Each takes it the next time it calls in.`,
  local: (names: string[]) => `Set up at the box itself, so it keeps its own network until you send it the club's: `
    + `${listNames(names)}. Use “Send it the club network” on its card.`,
  baseLabel: "Server address the boards call",
  baseHint: "http:// then the server's IPv4 address or a name the club router resolves, and an optional :port.",
  firstTitle: "First WiFi (tried first)",
  secondTitle: "Second WiFi (optional — tried next)",
  ssidLabel: "WiFi name",
  pskLabel: "WiFi password",
  pskKept: "A password is saved. Leave this empty to keep it; it is never shown.",
  pskHint: "8 to 63 characters. It is never shown again after it is saved.",
  openNetwork: "Open network (no password)",
  ssidRequired: "The boards need at least one WiFi name.",
  pskRequired: "Type the WiFi password, or tick “Open network” if it has none.",
  confirmTitle: "Send this network to every board?",
  confirm: (fallback: number | null) => "Every board will try this address and WiFi the next time it calls in. If it is wrong,"
    + ` a board goes back to the network it had after ${fallback ?? "a few"} minutes`
    + " and says so here — so a typo cannot strand it. To move to a new router, add it as the second WiFi first, wait"
    + " until every board shows the new version, then switch the router.",
  saved: (ver: number) => `Network version ${ver} saved. The boards take it the next time they call in.`,
};

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Which boards have not applied the club's network yet, and which keep their own (`net_src: local`). */
export function networkProgress(devices: readonly AdminDevice[], clubVer: number): { behind: AdminDevice[]; local: AdminDevice[] } {
  const live = devices.filter((d) => d.enabled && deviceCaps(d).has("net:1"));
  return {
    behind: live.filter((d) => d.net_src !== "local" && typeof d.net_ver === "number" && d.net_ver < clubVer),
    local: live.filter((d) => d.net_src === "local"),
  };
}

// ---------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------

/** The v3 device refusals, in words. Read before the shared dictionary. */
export const DEVICE_V3_CODES: Readonly<Record<string, string>> = {
  rotation_in_progress: KEY_COPY.inProgress,
  boards_would_be_stranded: "Retiring the old key now would cut boards off — they are named above.",
  owner_only: KEY_COPY.ownerOnly,
  key_invalid: KEY_COPY.restoreKeyInvalid,
  confirm_mismatch: "The confirmation did not match. Nothing changed.",
  network_changed: "Somebody saved the club network since you opened it. Nothing was saved — the page now shows theirs.",
  not_local: "This board already takes the club's network; there is nothing to push.",
};

export function describeV3Refusal(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const code = err.code;
  return code && DEVICE_V3_CODES[code] ? DEVICE_V3_CODES[code] : null;
}
