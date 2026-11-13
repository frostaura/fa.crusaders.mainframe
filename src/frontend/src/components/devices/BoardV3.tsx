import { useState } from "react";
import { deviceCaps, type AdminDevice } from "../../lib/api";
import {
  boardKeyLine, firmwareLine, latestRelease, megaLine, networkLine, screenLine, targetOf,
} from "../../lib/deviceV3Copy";
import { asLayout, landingClock } from "../../lib/landingPreview";
import {
  effectiveLayout, effectiveMarquee, servesScreen, servesStatusLines, type BoardsContext, type ClubScreen,
} from "../../lib/boardScreen";
import { Button } from "../ui/button";
import { RadioCard, RadioGroup } from "../ui/radio-group";
import { LandingPreview } from "./LandingPreview";

/**
 * One board's v3 state and remote fixes on Boards (device-api §10, FA-6, FA-12): what its screen
 * is showing and what it was asked for, a preview of its own start screen, firmware against the
 * latest release, the Mega's version and last restart, its network and key, and its capabilities.
 *
 * <p>
 * <b>Everything is presence-gated.</b> An API that serves none of the v3 fields renders none of
 * this — a line built from `undefined` would be the screen inventing a box's state.
 * </p>
 */

/** The status lines under a board's name: firmware, Mega, network, key, capabilities. */
export function BoardStatusLines({ device, context }: { device: AdminDevice; context: BoardsContext }) {
  if (!servesStatusLines(device, context)) return null;
  const latest = context.releases ? latestRelease(context.releases, targetOf(device)) : null;
  const caps = [...deviceCaps(device)].sort();
  const lines = [
    firmwareLine(device, latest),
    megaLine(device),
    networkLine(device, context.networkVer),
    boardKeyLine(device, context.keyId, context.nextKeyId),
    device.restore_report === "cold" ? "After its last power cut it restored from what it had saved" : null,
    caps.length > 0 ? `Can: ${caps.join(" ")}` : null,
  ].filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  return (
    <ul data-board-status="" className="mt-1 flex flex-col gap-0.5 break-words text-xs text-text-muted">
      {lines.map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
}

/**
 * The board's screen: what it shows, a preview of its own start screen, and the one-press
 * "Back to compact" that is always one heartbeat from taking effect (§5).
 */
export function BoardScreen({ device, context, onBackToCompact, busy }: {
  device: AdminDevice;
  context: BoardsContext;
  onBackToCompact: () => void;
  busy: boolean;
}) {
  if (!servesScreen(device)) return null;
  const layout = effectiveLayout(device, context.club);
  const marquee = effectiveMarquee(device, context.club);
  const courts = context.courtsOf(device);
  const showsExpanded = layout === "expanded" || device.lcd_layout_acknowledged === "expanded";
  return (
    <div data-board-screen="" className="flex flex-col gap-2 rounded-lg border border-border p-2 @[16rem]/boardslot:p-3">
      <p className="text-sm text-text-secondary">{screenLine(device, layout)}</p>
      {courts && (
        <LandingPreview
          layout={layout} marquee={marquee} courts={courts} clock={landingClock(context.now, context.timezone)}
          stepMs={context.club.stepMs} pageSeconds={context.club.pageSeconds}
          caption={`${device.name}'s start screen now (${layout === "expanded" ? "expanded, 20×4" : "compact, 16×2"})`}
        />
      )}
      {showsExpanded && (
        <Button variant="outline" size="sm" className="self-start" pending={busy} onClick={onBackToCompact}>
          Back to compact
        </Button>
      )}
    </div>
  );
}

type Choice = "club" | "compact" | "expanded";
type MarqueeChoice = "club" | "on" | "off";

/** The per-board layout and marquee overrides, three-valued exactly like the button map. */
export function BoardScreenEditor({ device, club, onSave, onClose }: {
  device: AdminDevice;
  club: ClubScreen;
  onSave: (layout: string | null, marquee: boolean | null) => Promise<boolean>;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<Choice>(device.lcd_layout === "compact" || device.lcd_layout === "expanded" ? device.lcd_layout : "club");
  const [marquee, setMarquee] = useState<MarqueeChoice>(
    device.lcd_marquee_enabled === true ? "on" : device.lcd_marquee_enabled === false ? "off" : "club");
  const [saving, setSaving] = useState(false);
  const clubLayout = asLayout(club.layout) === "expanded" ? "expanded" : "compact";

  async function save() {
    setSaving(true);
    try {
      const ok = await onSave(layout === "club" ? null : layout, marquee === "club" ? null : marquee === "on");
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-muted p-2 @[16rem]/boardslot:p-4">
      <RadioGroup value={layout} onValueChange={(v) => setLayout(v as Choice)} disabled={saving}
        aria-label={`${device.name} screen layout`} className="grid gap-2 sm:grid-cols-3">
        <RadioCard value="club" title={`The club's (${clubLayout})`} />
        <RadioCard value="compact" title="Compact 16×2" />
        <RadioCard value="expanded" title="Expanded 20×4" description="Needs a 20×4 panel." />
      </RadioGroup>
      <RadioGroup value={marquee} onValueChange={(v) => setMarquee(v as MarqueeChoice)} disabled={saving}
        aria-label={`${device.name} scrolling`} className="grid gap-2 sm:grid-cols-3">
        <RadioCard value="club" title={`The club's (${club.marquee === false ? "off" : "on"})`} />
        <RadioCard value="on" title="Scroll long lines" />
        <RadioCard value="off" title="Cut long lines" />
      </RadioGroup>
      <p className="text-xs text-text-muted">
        The box takes it up the next time it calls in. A box that cannot reach the club draws compact.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button pending={saving} onClick={() => void save()}>Save screen</Button>
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}
