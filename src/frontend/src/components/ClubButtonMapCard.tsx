import { useState } from "react";
import { endpoints, type AdminSettings } from "../lib/api";
import { describeDeviceError } from "../lib/deviceErrors";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./ui/card";
import { SquaresFour } from "./ui/icons";
import { ButtonMapEditor, buttonMapWithinCap } from "./ButtonMapEditor";
import { useToast } from "./Toast";

/**
 * The club's button map, and the warning about the buttons its own walk-up cap will refuse.
 *
 * <p>
 * <b>Why this is its own file.</b> `AdminDevicesPage` is measured by `make complexity` at
 * `-L 200` and had two lines of headroom: 198. Three rounds running have each added a sentence
 * to that screen, and round 10's extraction of the coverage copy moved 149 lines out of the
 * FILE while adding one inside the COMPONENT — so the trend was the wrong way even while the
 * diff read as a shrink. lizard measures a `.tsx` function by the span it last scoped, so
 * extracting into the same file changes nothing; only another file does. A page that has to
 * choose between saying something true and passing a gate will pick the gate, which is the
 * failure this is here to prevent rather than a tidy-up.
 * </p>
 *
 * <p>
 * The club map is the natural piece to take: it is the one thing on that screen that is not
 * about a box. Everything else there — the key, the rows, the coverage copy, the poller —
 * answers "what hardware does this club have and what is it doing", and this answers "what do
 * the eight buttons mean". It owns its own save and its own saving flag; the page keeps the
 * value, because the rows read it as `clubMap` for the per-box override editor.
 * </p>
 */

/** The grant a `minutes:N` button makes, or null for any other action. */
function grantMinutes(wire: string): number | null {
  const text = wire.trim().toLowerCase();
  if (!text.startsWith("minutes:")) return null;
  const minutes = Number(text.slice(8) || "15");
  return Number.isFinite(minutes) ? minutes : null;
}

/** The 1-based button numbers in this map that grant more than `cap` minutes. */
function buttonsOverCap(map: string[], cap: number): number[] {
  const over: number[] = [];
  map.forEach((wire, index) => {
    const minutes = grantMinutes(wire);
    if (minutes !== null && minutes > cap) over.push(index + 1);
  });
  return over;
}

/**
 * Says which minute buttons the club's own walk-up maximum will refuse.
 *
 * <p>
 * The editor validates against the relay hard cap of 90 and nothing else, so lowering
 * `walk_up_max_minutes` to 20 left every box still advertising 15/30/45/60 while the API
 * refused three of the four presses with `minutes_out_of_range` — the club's own
 * configuration change, blamed on the member, at a court with nobody at the desk
 * (finding M-F1). The word "walk-up" did not appear on this page at all.
 * </p>
 *
 * <p>
 * A warning rather than a refusal: the cap can be raised afterwards, and a button map that
 * anticipates that is not wrong. Blocking the save would also deadlock the two screens
 * against each other.
 * </p>
 *
 * <p>
 * Exported because a single box's own override editor shows the same warning about the same
 * cap, and two copies of this sentence is how the two screens disagreed in the first place.
 * </p>
 */
export function WalkUpCapNotice({ map, cap }: { map: string[]; cap: number | null }) {
  if (cap === null) return null;
  const over = buttonsOverCap(map, cap);
  if (over.length === 0) return null;

  const one = over.length === 1;
  return (
    <p className="rounded-lg bg-warning-soft p-3 text-sm text-warning-strong">
      {/* The possessive is an expression, not JSX text: lizard reads a lone apostrophe in JSX
          text as a string opener and swallows the rest of the file, which is why this file's
          previous home reported a 166-NLOC WalkUpCapNotice nobody wrote. Output is identical. */}
      {one ? `Button ${over[0]} grants` : `Buttons ${over.join(", ")} grant`} more than {"this club's "}
      walk-up maximum of {cap} minutes, so the box refuses {one ? "that press" : "those presses"} and
      sends the member to the desk. Raise <b>Walk-up maximum (minutes)</b> under Admin settings, or
      lower {one ? "the button" : "the buttons"}.
    </p>
  );
}

export function ClubButtonMapCard({
  settings, value, onChange, loading, walkUpCap,
}: {
  /** Null until the settings load. The save needs the eight booking fields off it. */
  settings: AdminSettings | null;
  value: string[];
  onChange: (next: string[]) => void;
  loading: boolean;
  /** The club's walk-up maximum, never above the relay hard cap. Null before settings load. */
  walkUpCap: number | null;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      // The button map, and the eight booking fields the API requires on every PUT.
      // Nothing else.
      //
      // This used to spread the whole settings document read at mount — and "present as
      // read" is not a no-op, it is a write of a value that may be minutes stale. An
      // admin raising the code lifetime in another tab had it reverted the moment this
      // screen saved a remapped button, silently, and the comment here claimed the
      // opposite (review finding 23). Re-GETting immediately before the PUT would only
      // narrow that window, not close it — the race moves into the gap between the two
      // calls — and it still writes twenty keys this screen does not own. Sending only
      // what this screen owns cannot revert anything, because the API reads an absent
      // key as unchanged. The seven below are not optional on the API and are the
      // booking form's, not this one's; they are the price of there being no PATCH.
      await endpoints.adminSettingsSave({
        slice_minutes: settings.slice_minutes,
        advance_booking_days: settings.advance_booking_days,
        day_start_minute: settings.day_start_minute,
        day_end_minute: settings.day_end_minute,
        penalty_pct: settings.penalty_pct,
        grace_window_minutes: settings.grace_window_minutes,
        penalty_window_minutes: settings.penalty_window_minutes,
        button_map: value,
      });
      toast.push({ tone: "success", text: "Button map saved. Boxes pick it up on their next heartbeat." });
    } catch (e) {
      // The server checks the map against every box's court list and names the one
      // that cannot honour it. That sentence is the whole point of the refusal.
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not save the button map."), durationMs: 8000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2 className="flex items-center gap-2">
            <SquaresFour size={20} aria-hidden="true" className="shrink-0 text-text-muted" />
            Button map
          </h2>
        </CardTitle>
        <CardDescription>
          What each of the eight buttons on a court box does. The wiring never changes — button 1 is always
          the same physical button — so you can swap courts around here without anyone touching the hardware.
          &ldquo;Court A&rdquo; means whatever court is on relay A of the box being pressed. Boxes pick up a change on
          their next heartbeat. A box given its own map above ignores this one.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <ButtonMapEditor value={value} onChange={onChange} disabled={saving || loading} />
        <WalkUpCapNotice map={value} cap={walkUpCap} />
      </CardContent>

      <CardFooter>
        <Button pending={saving} className="h-auto max-w-full whitespace-normal py-2" onClick={() => void save()} disabled={loading || !buttonMapWithinCap(value)}>
          Save button map
        </Button>
      </CardFooter>
    </Card>
  );
}
