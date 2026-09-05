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
   * own key inside the grant window and the admin only needs this as a fallback; a
   * re-claimed one does the same but on a row the club already had; a box registered
   * by hand, or whose key was rotated, has nothing else.
   */
  via: "claim" | "reclaim" | "register" | "rotate";
  /**
   * What the API said alongside the key, when it said anything. On rotation this is
   * the sentence that explains delivery — the key cannot be pushed to the board, so it
   * is collected by re-claiming — and it is shown verbatim rather than paraphrased.
   */
  note?: string;
};

/** The headline's account of where the key came from. */
const ISSUED_AS: Record<IssuedKey["via"], string> = {
  claim: "first claim",
  reclaim: "re-keyed",
  register: "registered by hand",
  rotate: "rotated",
};

/**
 * What to do next, per route.
 *
 * <p>
 * Every one of these ends at the same place, and the wording has to reach it without
 * contradicting the form above: a board collects its key by presenting the claim code
 * it is displaying, and a claim code is generated fresh on the board every time it
 * comes up unclaimed. So "connect it again" is never a matter of pressing the button a
 * second time — the form is cleared on success, the board has left the claimable list,
 * and the code on the LCD is a different one. It is: wait for it to reappear, read the
 * NEW code, type that. The earlier copy said "press Connect again", which is the one
 * instruction that cannot work.
 * </p>
 */
const FOLLOW_UP: Record<IssuedKey["via"], string> = {
  claim:
    "The board collects this key by itself, within ten minutes of Connect. If it is still showing CLAIM CODE after "
    + "that, the grant has lapsed: power-cycle the box, wait for it to reappear in the list above, and connect it again "
    + "with the NEW code on its screen — a board generates a fresh claim code every time, so the one you just typed is "
    + "spent. It is the same box, so it is re-keyed onto this same row rather than added twice. "
    + "Keep this key only if you are flashing the board by hand: it goes in secrets.h as DEVICE_KEY.",
  reclaim:
    "This board already had a row here — revoked, reflashed, or its key lost — so that row was re-keyed and re-enabled "
    + "rather than registered a second time: same box, same history, key version bumped. The board collects this key by "
    + "itself within ten minutes of Connect. If it still shows CLAIM CODE after that, power-cycle it, wait for it to "
    + "reappear in the list above, and connect it again with the NEW code on its screen. "
    + "Keep this key only if you are flashing the board by hand: it goes in secrets.h as DEVICE_KEY.",
  register:
    "Flash it into the board's secrets.h as DEVICE_KEY before leaving this page — a box registered by hand has no other "
    + "way to get its key, and this club has no board address for it, so it cannot be re-claimed later either.",
  rotate:
    "The old key stopped working the moment this one was issued, so the box's next call is refused and it drops back to "
    + "showing CLAIM CODE. Wait for it in the list above and connect it again with the code now on its screen — that "
    + "re-keys this same box and hands it the key. "
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
      <div className="font-medium">
        {issued.name} — device key, version {issued.keyVersion} ({ISSUED_AS[issued.via]}). Shown once.
      </div>
      <div className="mt-1 flex items-start gap-2">
        <code className="block min-w-0 flex-1 break-all font-mono text-xs" aria-label="Device key">{issued.key}</code>
        <Button variant="outline" className="h-8 shrink-0 px-2 text-xs" onClick={() => void copy()} aria-label="Copy device key">
          <Copy className="mr-1 h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {issued.note && <p className="mt-2 text-xs font-medium" aria-label="Note from the server">{issued.note}</p>}
      <p className="mt-2 text-xs">{FOLLOW_UP[issued.via]}</p>
      <Button variant="ghost" className="mt-2 h-8 px-2 text-xs" onClick={onDismiss}>I've stored it</Button>
    </div>
  );
}
