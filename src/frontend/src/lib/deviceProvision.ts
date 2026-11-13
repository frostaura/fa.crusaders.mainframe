/**
 * What a board will adopt from the club's network settings and key — the `provision/` contract
 * (`src/contracts/device-protocol/provision/gen_cases.py`, `base_url`, `adopt_net`, `adopt_key`),
 * so the console says "a board would refuse this" before a save rather than after a fleet ignored it.
 *
 * <p>
 * <b>The server decides.</b> The API validates every save with the same rules and its refusal is
 * the corpus reason; this module only lets the form say it first, in words. `deviceProvision.test.ts`
 * executes every `base_urls` vector and the key grammar against it.
 * </p>
 */

export const BASE_URL_MAX = 96;

/** The corpus `reason` for a base URL: `ok`, or why a board would refuse it. */
export type BaseUrlReason = "ok" | "empty" | "too_long" | "https" | "grammar" | "host" | "port";

const BASE_RE = /^http:\/\/(?<host>[^:/?#@\s]+)(?::(?<port>[0-9]{1,5}))?$/;
const IPV4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const NAME_RE = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** `base_url`: http only, no path, no query, no userinfo, no trailing slash; IPv4 or a lowercase name; port 1–65535. */
export function checkBaseUrl(url: string): BaseUrlReason {
  if (url.length === 0) return "empty";
  if (url.length > BASE_URL_MAX) return "too_long";
  if (url.startsWith("https://")) return "https";
  const match = BASE_RE.exec(url);
  if (!match?.groups) return "grammar";
  const { host, port } = match.groups;
  if (!(IPV4_RE.test(host) || (NAME_RE.test(host) && !/^\d+$/.test(host.replaceAll(".", ""))))) return "host";
  if (port !== undefined && (port.startsWith("0") || Number(port) < 1 || Number(port) > 65535)) return "port";
  return "ok";
}

/** What an admin reads for each refusal. */
export const BASE_URL_WORDS: Readonly<Record<Exclude<BaseUrlReason, "ok">, string>> = {
  empty: "Give the address the boards call, for example http://192.168.1.20:8088.",
  too_long: `The address is longer than the ${BASE_URL_MAX} characters a board can hold.`,
  https: "Boards can only call plain http:// on the club network — they have no room for https.",
  grammar: "Write it as http:// then the server's address and an optional :port — no path, no slash at the end.",
  host: "The server's address has to be an IPv4 address (192.168.1.20) or a lowercase name (mainframe.lan).",
  port: "The port has to be a number from 1 to 65535, with no leading zero.",
};

/** `adopt_net`'s SSID rule: 1–32 bytes, no control characters. */
export function ssidProblem(ssid: string): string | null {
  const bytes = new TextEncoder().encode(ssid).length;
  if (bytes < 1 || bytes > 32) return "A WiFi name is 1 to 32 characters.";
  for (const ch of ssid) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "A WiFi name cannot hold control characters.";
  }
  return null;
}

/** `adopt_net`'s password rule: empty (an open network) or 8–63 printable ASCII characters. */
export function pskProblem(psk: string): string | null {
  for (const ch of psk) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return "A WiFi password can hold only plain letters, digits, spaces and punctuation.";
  }
  if (psk.length !== 0 && (psk.length < 8 || psk.length > 63)) return "A WiFi password is 8 to 63 characters, or empty for an open network.";
  return null;
}

/** A device key as a board holds it: exactly 43 base64url characters. */
export function isDeviceKey(key: string): boolean {
  return KEY_RE.test(key);
}
