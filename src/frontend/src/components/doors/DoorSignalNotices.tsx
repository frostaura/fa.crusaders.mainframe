import { Link } from "react-router-dom";
import { Card } from "../Card";
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
export function DoorSignalNotices({ doorName, signals, settings }: {
  doorName: string;
  signals: DoorSignal[];
  settings: SignalSettings;
}) {
  const notices = signals
    .map((signal) => noticeFor(doorName, signal, settings))
    .filter((notice): notice is { text: string; link: boolean } => notice !== null);
  if (notices.length === 0) return null;
  return (
    <>
      {notices.map((notice) => (
        <Card key={notice.text} role="status" className="border-l-4 border-warning-strong bg-warning-soft">
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
