import { ApiError, deviceCaps, type AdminDevice, type DeviceKeyBoard, type FirmwareRelease } from "./api";
import { clubDayAndClock } from "./clubClock";

/**
 * The words the Boards page says about the device contract v3 (device-api §6–§8, §10): key
 * rotation, the club network, firmware, each board's screen. One module, so a sentence a test
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
  retire: (oldId: string) => `Every board still on key ${oldId} stops reaching the club the moment it is retired, and a `
    + "board that cannot rotate can then be fixed only with a cable. Retire it only if it has leaked.",
  retireType: (oldId: string) => `Type ${oldId} to retire it`,
  retireNotReady: (oldId: string) => `Type ${oldId} — the id of the key being retired — to confirm.`,
  retired: (oldId: string) => `Key ${oldId} is retired. Boards on it can no longer reach the club.`,
  stranded: (boards: string) => `These boards would be cut off: ${boards}.`,
  restoreTitle: "Put back a key the boards already hold?",
  restore: "After the club's database is lost or rebuilt, the boards still hold the key they had. Paste it here to make "
    + "it the club's current key again, so they can call in. Only the club's owner can do this; the key is never shown "
    + "again after it is saved.",
  restoreWord: "RESTORE",
  restoreNotReady: "Paste the 43-character key and type RESTORE to confirm.",
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
// Each board: screen, firmware, network (§2, §5, §7, §8)
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

const FW_STATE_WORDS: Readonly<Record<string, string>> = {
  committed: "running",
  probation: "on trial — it must reach the club to keep the new firmware",
  downloading: "downloading an update",
  rolled_back: "put its previous firmware back",
  failed: "refused an update",
};

const FW_ERROR_WORDS: Readonly<Record<string, string>> = {
  probation: "it did not reach the club in time after the update",
  sig: "the signature did not verify",
  sha256: "the image did not match its fingerprint",
  size: "the image was the wrong size",
  http: "the download failed",
  space: "there was not enough room",
  flash: "writing it failed",
  target: "it was for another kind of board",
  version: "it was not newer",
  busy: "the box was busy",
};

/** The firmware line: running version, what state it is in, and whether a newer release exists. */
export function firmwareLine(device: AdminDevice, latest: FirmwareRelease | null): string | null {
  const running = device.running_version;
  if (!running && !device.fw_state) return null;
  const state = device.fw_state ? FW_STATE_WORDS[device.fw_state] ?? `reports “${device.fw_state}”` : null;
  const parts = [running ? `Firmware ${running}` : "Firmware"];
  if (state && device.fw_state !== "committed") parts.push(state);
  if (device.fw_failed) {
    const why = device.fw_error ? FW_ERROR_WORDS[device.fw_error] ?? device.fw_error : null;
    parts.push(`${device.fw_failed} was refused${why ? ` — ${why}` : ""}, and will not be tried again`);
  }
  if (latest && running && compareVersions(latest.version, running) > 0) parts.push(`${latest.version} is available`);
  if (latest && running && compareVersions(latest.version, running) <= 0) parts.push("up to date");
  return parts.join(" · ");
}

/** The Mega's version and its last reset cause (`MCUSR`: bit0 power-on, bit1 external, bit2 brown-out, bit3 watchdog). */
export function megaLine(device: AdminDevice): string | null {
  if (!device.mega_version && !device.mega_reset_cause) return null;
  const cause = megaResetWords(device.mega_reset_cause);
  const parts = [device.mega_version ? `Mega ${device.mega_version}` : "Mega"];
  if (cause) parts.push(`last restart: ${cause}${device.mega_reset_at ? ` at ${at(device.mega_reset_at)}` : ""}`);
  return parts.join(" · ");
}

/** `MCUSR` in words, or null when it is not two hex digits. */
export function megaResetWords(hex: string | null | undefined): string | null {
  if (!hex || !/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
  const bits = Number.parseInt(hex, 16);
  const words: string[] = [];
  if (bits & 0x01) words.push("power came on");
  if (bits & 0x02) words.push("its reset button");
  if (bits & 0x04) words.push("the power dipped");
  if (bits & 0x08) words.push("it froze and restarted itself");
  return words.length === 0 ? "no cause recorded" : words.join(" and ");
}

/** The network line: the version applied and where it came from. */
export function networkLine(device: AdminDevice, clubVer: number | null): string | null {
  if (device.net_ver === undefined && device.net_src === undefined) return null;
  const src = device.net_src === "local" ? "set at the box itself"
    : device.net_src === "compiled" ? "what it was flashed with"
      : device.net_src === "server" ? "from the club" : null;
  const ver = typeof device.net_ver === "number" ? `network version ${device.net_ver}` : "network";
  const behind = clubVer !== null && typeof device.net_ver === "number" && device.net_src !== "local" && device.net_ver < clubVer
    ? `, the club's is ${clubVer} — it updates the next time it calls in` : "";
  return `${ver}${src ? ` (${src})` : ""}${behind}`;
}

/** Numeric `a.b.c` compare: positive when `a` is newer. A malformed part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest release of a target, or null. */
export function latestRelease(releases: readonly FirmwareRelease[], target: string): FirmwareRelease | null {
  return releases.filter((r) => r.target === target).reduce<FirmwareRelease | null>(
    (best, r) => (best === null || compareVersions(r.version, best.version) > 0 ? r : best), null);
}

/** The firmware target a board runs. The Mega is never a target: it cannot be updated over WiFi. */
export function targetOf(device: Pick<AdminDevice, "kind">): "court_bridge" | "door_gate" {
  return device.kind === "Gate" ? "door_gate" : "court_bridge";
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
  sig_invalid: "The signature did not verify against the club's firmware key. Nothing was uploaded — sign the image "
    + "again with the club's private key.",
  size_mismatch: "The image is not the size its manifest says. Upload the two files the signing tool wrote together.",
  sha256_mismatch: "The image does not match its manifest's fingerprint. Upload the two files the signing tool wrote together.",
  target_unknown: "The manifest names a kind of board the club does not have.",
  version_not_newer: "A release of this firmware at this version or newer is already uploaded. Publish a higher version.",
  manifest_invalid: "The manifest is not the file the signing tool wrote.",
  image_too_large: "The image is larger than this kind of board can take.",
  network_changed: "Somebody saved the club network since you opened it. Nothing was saved — the page now shows theirs.",
  not_local: "This board already takes the club's network; there is nothing to push.",
};

export function describeV3Refusal(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const code = err.code;
  return code && DEVICE_V3_CODES[code] ? DEVICE_V3_CODES[code] : null;
}
