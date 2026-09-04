import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "./Button";

/**
 * A device key, shown once.
 *
 * <p>
 * The key is derived, not stored — the API cannot show it again, and neither can this
 * page: it lives in component state only, never in localStorage or anywhere else a
 * later visitor could read it back. A toast that fades after four seconds is not a way
 * to hand somebody a secret, which is why this stays on screen until dismissed.
 * </p>
 *
 * <p>
 * The claim form used to drop this key on the floor. A board that misses its single-use
 * ten-minute provisioning grant — the API redeployed inside the window, the response
 * lost, a power cycle between Connect and collection — was then stranded with nothing
 * an admin could act on. Now they hold the key and know what to do with it.
 * </p>
 */
export type IssuedKey = {
  /** The device the key belongs to, as the admin knows it. */
  name: string;
  key: string;
  keyVersion: number;
  /**
   * How the key got issued, because the follow-up differs: a claimed board fetches its
   * own key inside the grant window and the admin only needs this as a fallback; a box
   * registered by hand, or whose key was rotated, has nothing else.
   */
  via: "claim" | "register" | "rotate";
};

const FOLLOW_UP: Record<IssuedKey["via"], string> = {
  claim:
    "The board collects this key by itself — it has ten minutes from Connect to do so. If it is still showing "
    + "CLAIM CODE after that, the grant has lapsed: power-cycle the box and press Connect again, and a fresh key is issued. "
    + "Keep this one only if you are flashing the board by hand: it goes in secrets.h as DEVICE_KEY.",
  register:
    "Flash it into the board's secrets.h as DEVICE_KEY before leaving this page — a box registered by hand has no other "
    + "way to get its key.",
  rotate:
    "The old key stopped working the moment this one was issued, so the box's next call is refused and it drops back to "
    + "showing CLAIM CODE. Connect it again from the list above — that re-keys this same box and hands it the key. "
    + "Flash the key into secrets.h as DEVICE_KEY only for a board provisioned by hand.",
};

export function IssuedKeyPanel({ issued, onDismiss }: { issued: IssuedKey; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.key);
      setCopied(true);
    } catch {
      // No clipboard (an insecure origin, or a browser that refuses). The key is on
      // screen and selectable; nothing else to do.
      setCopied(false);
    }
  }

  return (
    <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900" role="status">
      <div className="font-medium">{issued.name} — device key, version {issued.keyVersion}. Shown once.</div>
      <div className="mt-1 flex items-start gap-2">
        <code className="block min-w-0 flex-1 break-all font-mono text-xs" aria-label="Device key">{issued.key}</code>
        <Button variant="outline" className="h-8 shrink-0 px-2 text-xs" onClick={() => void copy()} aria-label="Copy device key">
          <Copy className="mr-1 h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="mt-2 text-xs">{FOLLOW_UP[issued.via]}</p>
      <Button variant="ghost" className="mt-2 h-8 px-2 text-xs" onClick={onDismiss}>I've stored it</Button>
    </div>
  );
}
