import { useCallback, useEffect, useState } from "react";
import { adminEndpoints, type ControlBoardView } from "../../lib/adminApi";
import type { AdminSettings } from "../../lib/api";
import { asLayout, landingClock, landingCourtsFor, type LcdLayout } from "../../lib/landingPreview";
import { useTicker } from "../../lib/useTicker";
import { Skeleton } from "../ui/skeleton";
import { StateBlock } from "../ui/state-block";
import { LandingPreview } from "./LandingPreview";

/**
 * Settings › Box screens: the start screen in both layouts, drawn from the courts' lights right
 * now (device-api §10, FA-6), so the admin choosing "expanded" sees what the club's boxes will say.
 *
 * <p>
 * The courts are one box's — the first enabled box the control board lists, in its relay order —
 * because that is what one glass shows. A club whose board list is empty is shown its courts in
 * number order, up to the four a box can drive. A failed read says so, with a retry, and draws
 * nothing it does not know: a preview of dark courts would be a claim about lights nobody read.
 * </p>
 */
export function ScreensPreview({ settings }: { settings: AdminSettings }) {
  const [view, setView] = useState<ControlBoardView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const now = useTicker(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await adminEndpoints.controlBoard());
    } catch (err) {
      setError(err ?? new Error("unread"));
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom
  useEffect(() => { void load(); }, [load]);

  const chosen: LcdLayout = asLayout(settings.lcd_layout);
  const marquee = settings.lcd_marquee_enabled !== false;
  const box = view?.boxes?.find((b) => b.enabled && b.court_numbers.length > 0);
  const numbers = box
    ? box.court_numbers
    : [...(view?.courts ?? [])].map((c) => c.court_number).sort((a, b) => a - b).slice(0, 4);
  const courts = view ? landingCourtsFor(numbers, view.courts, now) : [];
  const clock = landingClock(now, view?.timezone);
  const common = {
    marquee, courts, clock, stepMs: settings.lcd_marquee_step_ms, pageSeconds: settings.lcd_landing_page_seconds,
  };

  return (
    <section aria-labelledby="screens-preview-title" className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h3 id="screens-preview-title" className="text-sm font-semibold text-text-primary">What the start screen shows now</h3>
      <p className="max-w-prose text-sm text-text-secondary">
        {box ? `${box.name ?? box.device_code}'s courts, with their lights as the club sees them. ` : "The club's courts, with their lights as the club sees them. "}
        It follows the layout and scrolling chosen above before you save. Each box draws only its own courts, and never a name.
      </p>
      <StateBlock
        loading={loading}
        error={error}
        action="read the courts' lights"
        failedCaveat="The preview needs them, so it is not drawn."
        onRetry={() => void load()}
        skeleton={<Skeleton className="h-24 w-full max-w-md" />}
      >
        <div className="flex flex-wrap gap-6">
          <LandingPreview {...common} layout="compact" caption="Compact, 16×2" selected={chosen === "compact"} />
          <LandingPreview {...common} layout="expanded" caption="Expanded, 20×4" selected={chosen === "expanded"} />
        </div>
      </StateBlock>
    </section>
  );
}
