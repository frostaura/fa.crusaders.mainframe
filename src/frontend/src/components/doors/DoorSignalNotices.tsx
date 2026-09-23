import { Link } from "react-router-dom";
import { Panel as Card } from "./Panel";
import { doorMayNotBeReleasingNotice, doorRefusalSpikeNotice } from "../../lib/doorsCopy";
import { type DoorSignal } from "../../lib/api";

/**
 * What the club's settings have to be readable for, before a signal may be rendered.
 *
 * A spike notice states a threshold and a window, and both are the club's own numbers. With
 * the settings read failed there is no honest sentence to write — a threshold stated with a
 * guessed number is worse than no spike notice at all — so the notice does not render.
 */
export type SignalSettings = {
  spikeMinutes: number | null;
  unlockSeconds: number | null;
};

/**
 * The full notices for a door's signals — on the detail page only.
 *
 * <p>
 * A signal is a READING of events, not an event. It appears as a chip on the tile and as a
 * notice here, and it appears nowhere else: never in a toast, never in an email (P7), never
 * on Home, and never as a row in the club log — a log row is a thing that happened, and this
 * is somebody's interpretation of several things that happened.
 * </p>
 *
 * <p>
 * `role="status"`, not `alert`: these are windowed readings that come and go on their own,
 * and an assertive region for a dirty scanner is a region an admin learns to talk over.
 * </p>
 */
export function DoorSignalNotices({ doorName, signals, settings, enabled = true, online = true }: {
  doorName: string;
  signals: DoorSignal[];
  settings: SignalSettings;
  /**
   * <b>B9 / A9: a signal does not survive a shut or an outage.</b>
   *
   * A reviewer read "may not be releasing… change how long the lock is released" on a door
   * the club had shut hours earlier, and "usually a dirty scanner" on one nothing could
   * reach. A signal is a reading of the last N minutes of SCANS: on a shut door those are
   * refusals the club itself caused, and on a cut-off door the club has not seen the recent
   * ones at all. The reading is about a question nobody is asking, and the advice attached to
   * it sends somebody to change a setting that is not the problem.
   */
  enabled?: boolean;
  /** `null` = this page cannot currently say (A8), which is not a state to judge signals in. */
  online?: boolean | null;
}) {
  if (!enabled || online !== true) return null;
  const notices = signals
    .map((signal) => noticeFor(doorName, signal, settings))
    .filter((notice): notice is { text: string; link: boolean } => notice !== null);
  if (notices.length === 0) return null;
  return (
    <>
      {notices.map((notice) => (
        /*
          <b>C-M2 / R3-26 — a ~50-word advisory re-spoken every fifteen seconds.</b>

          This page re-reads while the tab is in front, and a `role="status"` on a STANDING
          advisory means a screen reader is handed the whole paragraph again on every
          re-render that touches it. A signal is a windowed reading that comes and goes on
          its own; it is not an event, and it is not news each time the page checks. It is
          page text, in a headed block, reached by browsing — and the one thing on this
          surface that IS news when it changes (the shut state) has its own region in the
          chrome. See {@link ShutDoorsBanner}.
        */
        <Card key={notice.text} className="border-l-4 border-warning-strong bg-warning-soft">
          <p className="text-sm text-warning-strong">{notice.text}</p>
          {notice.link && (
            // A9: this used to be a bare `/admin/settings`, which lands an admin at the top
            // of a page about 5 400 px long with no idea which of its forty fields was
            // meant. The hash is the settings page's own `#setting-<key>` convention: it
            // scrolls that field into view, moves focus to it and highlights it.
            <Link
              to="/admin/settings#setting-gate-unlock-seconds"
              className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-warning-strong underline"
            >
              {`Change how long the lock is released — ${doorName}`}
            </Link>
          )}
        </Card>
      ))}
    </>
  );
}

function noticeFor(
  doorName: string, signal: DoorSignal, settings: SignalSettings,
): { text: string; link: boolean } | null {
  if (signal.kind === "refusal_spike") {
    if (settings.spikeMinutes === null) return null;
    return { text: doorRefusalSpikeNotice(doorName, signal.scans, settings.spikeMinutes), link: false };
  }
  return { text: doorMayNotBeReleasingNotice(doorName, settings.unlockSeconds), link: true };
}
