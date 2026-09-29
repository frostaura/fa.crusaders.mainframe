/**
 * Handing an invite link on: the phone's own share sheet first (WhatsApp is one tap away there),
 * then the clipboard, and — when neither is allowed — the page shows the link for a long-press.
 */

export type ShareOutcome = "shared" | "copied" | "dismissed" | "failed";

/** `/j/abc` → `https://club.example/j/abc`. An absolute path from the server is kept as it is. */
export function absoluteLink(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${window.location.origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function copy(url: string): Promise<ShareOutcome> {
  try {
    if (!navigator.clipboard?.writeText) return "failed";
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

/**
 * Web Share where the browser has it; the clipboard otherwise, or when the share sheet itself
 * fails. Closing the share sheet is the member's choice, not a failure, and says nothing.
 */
export async function shareLink(url: string, title: string, text: string): Promise<ShareOutcome> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title, text, url });
      return "shared";
    } catch (error) {
      if (isAbort(error)) return "dismissed";
    }
  }
  return copy(url);
}

/** The clipboard alone — the "Copy link" button beside Share. */
export function copyLink(url: string): Promise<ShareOutcome> {
  return copy(url);
}
