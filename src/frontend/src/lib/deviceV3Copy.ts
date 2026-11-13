import { ApiError, deviceCaps, type AdminDevice, type DeviceKeyBoard, type FirmwareRelease } from "./api";
import { RELAYS } from "./buttonMap";
import { clubDayAndClock } from "./clubClock";
import { mcusrWords } from "./deviceHealth";

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

/** The Mega's version and its last reset cause (`mega.reset`, the `MCUSR` it sent in `!BOOT`). */
export function megaLine(device: AdminDevice): string | null {
  const reset = device.mega?.reset;
  if (!device.mega_version && !reset) return null;
  const cause = mcusrWords(reset);
  const parts = [device.mega_version ? `Mega ${device.mega_version}` : "Mega"];
  if (cause) parts.push(`last restart: ${cause}`);
  return parts.join(" · ");
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
// Firmware (§7)
// ---------------------------------------------------------------------------------------

export const FIRMWARE_COPY = {
  lede: "Signed updates for the two WiFi chips — the court box's bridge and each door — pulled by the boards themselves."
    + " A board checks the signature before it starts the new image and puts the old one back if the new one cannot"
    + " reach the club. The court box's Mega cannot be updated over WiFi.",
  targetTitle: { court_bridge: "Court boxes (bridge)", door_gate: "Door gates" } as Record<string, string>,
  noReleases: "No release uploaded yet.",
  older: (versions: string[]) => `Earlier releases: ${versions.join(", ")}.`,
  offerLabel: "Offer it to",
  whichBoard: "Which board",
  rollout: { off: "Nobody", one: "One board", all: "Every board of this kind" } as Record<FirmwareRolloutWord, string>,
  confirmTitle: (version: string) => `Change who is offered ${version}?`,
  confirm: (rollout: FirmwareRolloutWord, board: string | null) => {
    if (rollout === "off") return "No board is offered it. A board already part-way through finishes, or puts its old firmware back by itself.";
    if (rollout === "one") return `${board ?? "That board"} is offered it the next time it calls in, and takes it when nobody is using`
      + " it. Lit courts stay lit. Try one board first; offer it to all once that board shows it running.";
    return "Every acknowledged board of this kind is offered it the next time it calls in, and each takes it when nobody is"
      + " using it. Lit courts stay lit. A board whose new firmware cannot reach the club puts the old one back by itself.";
  },
  confirmLabel: (rollout: FirmwareRolloutWord) => (rollout === "off" ? "Offer it to nobody" : "Offer the update"),
  applied: (rollout: FirmwareRolloutWord, version: string) => (rollout === "off"
    ? `${version} is offered to nobody.` : `${version} is offered. Boards take it the next time they call in.`),
  pauseTitle: "Pause this update?",
  pause: "No further board starts it. Boards already running it keep it.",
  resumeTitle: "Resume this update?",
  resume: "Boards it is offered to start taking it again the next time they call in.",
  paused: "The update is paused.",
  resumed: "The update is resumed.",
  uploadTitle: "Upload a signed release",
  imageLabel: "Firmware image (.bin)",
  manifestLabel: "Its manifest (.json)",
  manifestHint: "The two files the signing tool wrote, together. The club's system refuses an image whose signature does not verify.",
  uploadConfirmTitle: "Upload this release?",
  uploadConfirm: "The club's system checks the signature against the club's firmware key and stores it. Nothing is offered to any"
    + " board until you choose who gets it.",
  uploadNotReady: "Choose both the image and its manifest.",
  uploaded: (target: string, version: string) => `${FIRMWARE_TARGET_WORD[target] ?? target} ${version} uploaded. Choose who is offered it.`,
};

type FirmwareRolloutWord = "off" | "one" | "all";

const FIRMWARE_TARGET_WORD: Readonly<Record<string, string>> = { court_bridge: "Court box bridge", door_gate: "Door gate" };

/** One release, in a line: version, when, and who is offered it. */
export function releaseLine(release: FirmwareRelease): string {
  const who = release.rollout === "off" ? "offered to nobody"
    : release.rollout === "one" ? "offered to one board" : "offered to every board of this kind";
  const counts = Object.entries(release.boards ?? {}).filter(([, n]) => typeof n === "number" && n > 0)
    .map(([state, n]) => `${n} ${FW_STATE_SHORT[state] ?? state}`);
  return `${release.version}, uploaded ${at(release.uploaded_at)} — ${who}${release.paused ? ", paused" : ""}`
    + `${counts.length > 0 ? ` (${counts.join(", ")})` : ""}.`;
}

const FW_STATE_SHORT: Readonly<Record<string, string>> = {
  committed: "running it", probation: "on trial", downloading: "downloading", rolled_back: "put the old one back", failed: "refused it",
};

/** Each board of a target against the latest release: what its own heartbeat says. */
export function boardFirmwareProgress(devices: readonly AdminDevice[], latest: FirmwareRelease | null): { device: AdminDevice; words: string }[] {
  return devices.filter((d) => d.enabled).map((device) => ({ device, words: firmwareLine(device, latest) ?? "has not reported its firmware" }));
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
