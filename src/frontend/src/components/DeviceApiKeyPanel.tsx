import { useCallback, useEffect, useState } from "react";
import { Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { endpoints, type DeviceApiKey } from "../lib/api";
import { describeDeviceError } from "../lib/deviceErrors";
import { Card } from "./Card";
import { Button } from "./Button";
import { ConfirmButton } from "./ConfirmButton";
import { useToast } from "./Toast";

/**
 * The club's one device API key.
 *
 * <p>
 * This replaces the per-device key panel that stood here — a key shown once on claim,
 * registration or rotation, and never again. Under the current contract there is one
 * static key for the whole club, it goes into every box's `secrets.h`, and it is
 * retrievable rather than shown-once: the API holds it and hands it back on every GET.
 * That is deliberate. A club adding its fifth box next season has to be able to read the
 * key again, and a shown-once key with no way to read it back is exactly what produced
 * the claim / rotate / revoke / re-claim machinery this contract deleted.
 * </p>
 *
 * <p>
 * Kept in its own file for the same reason the one-time panel was: it is the only part
 * of the Devices screen that handles a secret, and the page beside it is a loader and a
 * layout.
 * </p>
 */

/**
 * Masks the key for the resting state.
 *
 * <p>
 * The ends are kept because the one question an admin asks of a key they cannot read is
 * "is this the same one I flashed?", and four characters at each end answers it. The
 * middle is a fixed run of bullets rather than one per character: a mask that leaked the
 * length would be a free bit of the secret to anybody reading over a shoulder.
 * </p>
 */
function maskKey(key: string): string {
  if (key.length <= 12) return "••••••••";
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

/** When the key was last minted, in words an admin reads rather than an ISO string. */
function describeRegenerated(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString();
}

/** The key itself: masked, revealable, copyable. */
/**
 * Where the keyboard lands once the key has been regenerated. (R3 adoption)
 *
 * A constant rather than a literal in two places: `focusAfter` names a node that the update
 * removing the control has not rendered yet, so the two spellings would have to agree across
 * a re-render nobody can see failing — the search would simply find nothing and fall silent.
 */
const DEVICE_KEY_LINE_ID = "device-api-key-line";

function KeyLine({ apiKey }: { apiKey: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const RevealIcon = revealed ? EyeOff : Eye;

  async function copy() {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
    } catch {
      // No clipboard (an insecure origin, or a browser that refuses). Reveal is the
      // fallback: the key is then on screen and selectable.
      setCopied(false);
    }
  }

  return (
    // B7 / B11 / R3-27. Three things, all measured at 320 px with a 32 px root font — the
    // large-text setting an older volunteer actually uses.
    //
    // `flex-wrap` and no `shrink-0`: the key and its two buttons were one unbreakable row,
    // so the panel's min-content was wider than the phone and the WHOLE PAGE scrolled
    // sideways. A row that can wrap costs a desktop nothing and is the same fix
    // `ButtonMapEditor` carries one card along, for the same reason.
    //
    // `min-h-11` rather than `h-9`: 36 px against the 44 px the doors pages are built to,
    // for the same volunteer in the same club — and a fixed height clips its own words once
    // they wrap, which at this text size they do.
    <div className="flex min-w-0 flex-wrap items-start gap-2">
      {/* The id is what `focusAfter` on the regenerate confirm lands on (R3 adoption): the
          key itself is the only thing on this panel that changed, and it carries its own
          accessible name, so focusing it reads the new key out. */}
      <code id={DEVICE_KEY_LINE_ID} className="block min-w-0 flex-1 break-all rounded-lg bg-bg-muted p-2 font-mono text-xs" aria-label="Device API key">
        {revealed ? apiKey : maskKey(apiKey)}
      </code>
      <Button variant="outline" className="min-h-11 px-2 text-xs" onClick={() => setRevealed((r) => !r)} aria-label={revealed ? "Hide device API key" : "Reveal device API key"}>
        <RevealIcon className="h-3.5 w-3.5" />
      </Button>
      <Button variant="outline" className="min-h-11 px-2 text-xs" onClick={() => void copy()} aria-label="Copy device API key">
        <Copy className="mr-1 h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * The three steps that get a box onto this screen, and the one sentence saying why a key
 * is involved at all.
 *
 * <p>
 * The topology is the part nobody guesses: the box and the backend are both on the club
 * LAN, and the member app reaches that same backend from outside through the tunnel. So
 * "it is on our network" is not an identity, which is the whole reason a box carries a
 * key rather than being trusted for its address.
 * </p>
 */
function PairingNote() {
  return (
    <div className="mt-4 rounded-lg bg-bg-muted p-3 text-sm text-text-secondary">
      <h3 className="mb-2 font-semibold text-text-primary">How to pair a board</h3>
      {/* `break-words`: the steps name files and make targets — `secrets.h`, `door_gate`,
          `box-xxxxxx` — and an identifier has no space to wrap at. At a 32 px root font the
          list's own `pl-5` leaves about 86 px here, and a 130 px unbreakable token pushed the
          card, the page and the viewport sideways rather than going to a second line. */}
      <ol className="list-decimal space-y-1 break-words pl-5">
        <li>Copy this key, and the club WiFi name and password, into that firmware’s <code className="font-mono text-xs">secrets.h</code> — a court box and a door gate each have their own.</li>
        <li>Flash it. A court box: <code className="font-mono text-xs">make flash-bridge</code>, or its sketch in the Arduino IDE. A door gate: the <code className="font-mono text-xs">door_gate</code> sketch in the Arduino IDE, board “ESP32 Dev Module”.</li>
        <li>Power it on. It appears under Connected boards by itself on its first heartbeat, named <code className="font-mono text-xs">box-xxxxxx</code> or <code className="font-mono text-xs">gate-xxxxxx</code> — then give a box its name and courts, or a door its name.</li>
      </ol>
      <p className="mt-2 text-xs">
        Every board and the backend sit on the club LAN; the member app reaches that same backend from outside
        through the tunnel. Being on the network is therefore not an identity, which is why each board carries this key.
      </p>
    </div>
  );
}

export function DeviceApiKeyPanel() {
  const toast = useToast();
  const [key, setKey] = useState<DeviceApiKey | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setKey(await endpoints.adminDeviceApiKey());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom in every other admin page here
  useEffect(() => { void load(); }, [load]);

  async function regenerate() {
    try {
      setKey(await endpoints.adminDeviceApiKeyRegenerate());
      toast.push({
        tone: "success",
        text: "New key issued. The old one stopped working immediately — every board, court boxes and door gates alike, has to be reflashed with this one before it can call in again.",
        durationMs: 10000,
      });
    } catch (e) {
      // Loud, because the failure this stops is silent: an admin who believes the key
      // rotated goes and flashes a fleet with a key the API never issued.
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not regenerate the key."), durationMs: 8000 });
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-text-muted" />
        <h2 className="text-lg font-semibold">Device API key</h2>
      </div>

      <p className="mb-3 text-sm text-text-secondary">
        One key for the whole club. Every court box and door gate carries it, and a board that presents it with a device code this club has
        not seen registers itself on its first heartbeat.
      </p>

      {failed && (
        <p className="rounded-lg bg-warning-soft p-3 text-sm text-warning-strong">
          Could not read the club's device key. Reload the page; if it keeps failing, the API is not serving it yet.
        </p>
      )}

      {key && (
        <>
          <KeyLine apiKey={key.api_key} />
          <p className="mt-2 text-xs text-text-muted">Last regenerated {describeRegenerated(key.regenerated_at)}.</p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <ConfirmButton
              idleLabel="Regenerate key"
              cancelLabel="Keep the current key"
              confirmLabel="Reflash every board after this — regenerate?"
              // R3 adoption. There is one club key, so the subject is the club's estate rather
              // than a row — but the way out was named "Cancel", which on the most expensive
              // control in the product says nothing about what it preserves. `focusAfter`
              // lands on the key line, which is what changed and is the only thing on the
              // panel that can tell a keyboard user the action landed.
              subject="the key every board is using"
              focusAfter={() => document.getElementById(DEVICE_KEY_LINE_ID)}
              onConfirm={regenerate}
              tone="danger"
            />
            <span className="text-xs text-text-secondary">
              The old key stops working immediately. Every board — court boxes and door gates — has to be reflashed with the new one before it can call in, and until then a door gate opens only for members with a booking on the list it last received, for at most six hours.
            </span>
          </div>

          <PairingNote />
        </>
      )}
    </Card>
  );
}
