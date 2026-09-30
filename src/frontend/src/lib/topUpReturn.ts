/**
 * Where a top-up started from, carried through the PayFast round-trip (R1, for lane F2's invite
 * journey: a share bigger than the member could spend sends them to top up, and the way back to
 * the invite must survive the gateway).
 *
 * <p>
 * PayFast's return and cancel URLs are the server's (`/wallet/topup/{id}` and `?cancelled=1`) and
 * carry nothing of ours, so the path is kept in `sessionStorage` under the top-up's id when the
 * member leaves for the gateway, and read back on the status page. `?returnTo=` on the status
 * page itself is honoured too. Only an in-app path is ever accepted — anything else would make
 * this an open redirect.
 * </p>
 */

const KEY_PREFIX = "crusaders.topup-return:";

export const TOPUP_RETURN_COPY = {
  invite: "Back to your invite",
  elsewhere: "Back to where you were",
} as const;

/** The value, when it is a same-origin app path ("/…", never "//…" or a scheme); otherwise null. */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (value.length > 512 || [...value].some((c) => c.charCodeAt(0) < 0x20)) return null;
  return value;
}

export function rememberTopUpReturn(topupId: string, path: string | null): void {
  const safe = safeReturnTo(path);
  if (!safe) return;
  try { window.sessionStorage.setItem(KEY_PREFIX + topupId, safe); } catch { /* the way back is simply not offered */ }
}

export function topUpReturnFor(topupId: string | undefined): string | null {
  if (!topupId) return null;
  try { return safeReturnTo(window.sessionStorage.getItem(KEY_PREFIX + topupId)); } catch { return null; }
}

/** What the way back is called: an invite by its name, anywhere else plainly. */
export function returnLabel(path: string): string {
  return path.startsWith("/j/") || path.startsWith("/invites/") ? TOPUP_RETURN_COPY.invite : TOPUP_RETURN_COPY.elsewhere;
}
