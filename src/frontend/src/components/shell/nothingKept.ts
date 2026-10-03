import { phoneIsOffline } from "@/lib/api";

/**
 * R7 X7-3 — a page's read is offline with nothing of it kept on this phone: no data, the read
 * failed, the club could not be reached AND the phone says it has no network. Then the page says
 * `OfflineNothingKept` (it loads by itself on the signal's return) rather than "couldn't be
 * reached" in red. A dropped connection on a phone that believes it is online keeps the failure
 * with its retry — nothing would bring the page back by itself.
 */
export function nothingKeptOffline(read: { hasData: boolean; error: unknown; offline?: boolean }): boolean {
  return !read.hasData && read.error !== null && read.error !== undefined && read.offline === true && phoneIsOffline();
}
