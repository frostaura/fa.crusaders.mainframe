import { useCallback, useEffect, useState } from "react";
import { ApiError, endpoints, type DeviceApiKey } from "../lib/api";
import { KeyRotationPanel } from "./devices/KeyRotationPanel";
import { DEVICE_KEY_LINE_ID } from "../lib/deviceV3Copy";
import { rateLimitedSentence } from "../lib/errors";
import { clubDayAndClock } from "../lib/clubClock";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { IconButton } from "./ui/icon-button";
import { Check, Copy, Eye, EyeSlash, Key } from "./ui/icons";

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
function describeSince(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return clubDayAndClock(at);
}

/**
 * The key itself: masked, revealable, copyable. Its line carries `DEVICE_KEY_LINE_ID`, where the
 * keyboard lands once the key changes — a constant, because `focusAfter` names a node the update
 * has not rendered yet, and two spellings would fail silently.
 */

function KeyLine({ apiKey }: { apiKey: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const RevealIcon = revealed ? EyeSlash : Eye;

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
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {/* The id is where focus lands after a key change: the key itself is the only thing
          on this panel that changed, and it carries its own accessible name, so focusing it
          reads the new key out. */}
      <code
        id={DEVICE_KEY_LINE_ID}
        tabIndex={-1}
        className="block min-w-0 flex-1 break-all rounded-lg border border-border bg-bg-muted px-3 py-2.5 font-mono text-sm text-text-primary"
        aria-label="Device API key"
      >
        {revealed ? apiKey : maskKey(apiKey)}
      </code>
      <IconButton variant="outline" label={revealed ? "Hide device API key" : "Reveal device API key"} onClick={() => setRevealed((r) => !r)}>
        <RevealIcon aria-hidden="true" />
      </IconButton>
      <Button
        variant="outline"
        aria-label="Copy device API key"
        onClick={() => void copy()}
        icon={copied ? <Check aria-hidden="true" className="text-success-strong" /> : <Copy aria-hidden="true" />}
      >
        {copied ? "Copied" : "Copy"}
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
    <div className="text-sm text-text-secondary @[16rem]/keycard:rounded-lg @[16rem]/keycard:border @[16rem]/keycard:border-border @[16rem]/keycard:bg-bg-muted @[16rem]/keycard:p-4">
      <h3 className="mb-2 font-semibold text-text-primary">How to pair a board</h3>
      {/* `break-words`: the steps name files and make targets — `secrets.h`, `door_gate`,
          `box-xxxxxx` — and an identifier has no space to wrap at. At a 32 px root font the
          list's own `pl-5` leaves about 86 px here, and a 130 px unbreakable token pushed the
          card, the page and the viewport sideways rather than going to a second line. */}
      <ol className="list-inside list-decimal space-y-1 break-words @[16rem]/keycard:list-outside @[16rem]/keycard:pl-5">
        <li>Copy this key, and the club WiFi name and password, into that firmware’s <code className="font-mono text-xs">secrets.h</code> — a court box and a door gate each have their own. These are only what a new board starts with: a key rotation, the club network below and a firmware update all reach it later without a cable.</li>
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
  const [key, setKey] = useState<DeviceApiKey | null>(null);
  // The error itself, not a flag (R3 V-10): a 429 is the club being busy, not a missing API.
  const [failed, setFailed] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setKey(await endpoints.adminDeviceApiKey());
      setFailed(null);
    } catch (err) {
      setFailed(err ?? new Error("unread"));
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom in every other admin page here
  useEffect(() => { void load(); }, [load]);

  return (
    // R7 L7-9: a size container. Under a 16rem card — 512px at 200 % text, so only large text —
    // the nested insets fold away: card, note box and list indent left the pairing steps an 88px
    // column at 320 / 200 %, a word a line with most words broken.
    <Card data-device-key-card="" className="@container/keycard">
      <CardHeader>
        <CardTitle asChild>
          <h2 className="flex items-center gap-2">
            <Key size={20} aria-hidden="true" className="shrink-0 text-text-muted" />
            Device API key
          </h2>
        </CardTitle>
        <CardDescription>
          One key for the whole club. Every court box and door gate carries it, and a board that presents it with a device code this club has
          not seen registers itself on its first heartbeat.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 px-2 @[16rem]/keycard:px-4">
        {failed !== null && (isDemoClub(failed)
          // The demo club: boards cannot connect to it, so there is no key — a fact, not a failure.
          ? <p data-device-key-demo="" className="text-sm text-text-secondary">{DEMO_NO_KEY}</p>
          : <p className="rounded-lg bg-warning-soft p-3 text-sm text-warning-strong">{keyReadFailure(failed)}</p>
        )}

        {key && (
          <>
            <div className="flex flex-col gap-2">
              <KeyLine apiKey={key.api_key} />
              <p className="text-xs text-text-muted">
                {key.key_id ? `Key ${key.key_id}, in use since ${describeSince(key.regenerated_at)}.` : `In use since ${describeSince(key.regenerated_at)}.`}
              </p>
            </div>

            {/* v3 §6: rotation with an overlap, never a regenerate that strands every board (BA-01). */}
            <KeyRotationPanel apiKey={key} onChanged={setKey} />

            <PairingNote />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The demo club answers `409 demo_mode` for its device key: boards cannot connect to it. */
function isDemoClub(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === "demo_mode";
}

/** Why the key could not be read — a rate limit is busy, not an API that lacks the route (R3 V-10). */
function keyReadFailure(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    return `Could not read the club's device key: ${rateLimitedSentence(Number(err.detail("retry_after_seconds")) || null)}`;
  }
  return "Could not read the club's device key. Reload the page; if it keeps failing, the API is not serving it yet.";
}

/**
 * The demo club's answer (`409 demo_mode`). Here rather than in `lib/demoModeCopy`, which is the
 * admin's demo chunk: sharing it would split a chunk off and name it in every member's entry.
 */
const DEMO_NO_KEY = "Boards can't connect to the demo club, so it has no device key. Switch back to the live club to pair a board.";
