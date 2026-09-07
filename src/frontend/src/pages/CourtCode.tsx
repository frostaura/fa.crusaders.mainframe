import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QrCode as QrIcon, RefreshCw } from "lucide-react";
import { ApiError, endpoints, type MyQrCode, type MyQrKind } from "../lib/api";
import { describeCourtCodeRefusal } from "../lib/bookingErrors";
import { encodeQr, qrPath } from "../lib/qr";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { cn } from "../lib/utils";

/**
 * The member's court code — what they hold up to the scanner on the court box.
 *
 * <p>
 * The QR carries the bare twelve-character code and nothing else. The box's scanner
 * pipeline caps an argument at 24 bytes and poisons anything longer, which is why the
 * previous design (a JWT in the QR) could never identify anyone at a court. Encoding a
 * URL, a prefix or a JSON wrapper around the code would break it just as thoroughly.
 * </p>
 *
 * <p>
 * The code is printed under the QR as well, because it is short enough to type: the
 * alphabet drops I, L, O and U so a code read off a phone at the desk cannot be misread.
 * </p>
 *
 * <p>
 * Two things about time. The countdown is derived from the server's
 * <code>expires_in_seconds</code> and the clock, never from counting ticks — a phone
 * locked in a pocket fires no ticks, and used to wake showing a live countdown over a
 * dead code. And the next code is fetched shortly <em>before</em> the current one runs
 * out and swapped in one state update, so a member at the box is never holding up a
 * code that has just died while the page fetches another. That pre-fetch is only worth
 * anything if the server actually rotates: it is allowed to answer with the code the
 * page already holds, and when it does, this page re-polls quickly rather than sitting
 * out the pacing gap over a dying QR (review finding 21).
 * </p>
 *
 * <p>
 * <b>Which code.</b> Left alone, the server picks: a booking code when the member has a
 * booking inside the roster window, an ident code otherwise. A booking code is refused
 * at every court but its own, so for the couple of hours before a booking that default
 * left the member with no way to walk up to a free court or pay for someone else — the
 * exact members who use the club most, sent to the desk (review finding 6). The
 * "walk up / pay for someone" switch asks for an ident code outright.
 * </p>
 */

/**
 * The generate endpoint sits behind the API's auth rate-limit bucket, which is shared
 * with login — and, until forwarded headers are honoured, shared by everyone behind the
 * club's gateway. This gap bounds what one open page can cost it: at most one call
 * every ten seconds, whatever the server says a code's lifetime is.
 */
const MIN_REFRESH_GAP_MS = 10_000;

/** How long before expiry the next code is fetched. Ten seconds covers a slow fetch with room to spare. */
const PREFETCH_LEAD_S = 10;

/**
 * The gap between re-polls when the server answered a pre-fetch with the code the page
 * already holds.
 *
 * <p>
 * A code that is about to die and a server that keeps handing it back is the whole of
 * the dead-QR window: waiting {@link MIN_REFRESH_GAP_MS} between attempts guarantees
 * the code reaches zero first. The server mints a fresh one once the current has less
 * than the lead time left, so in practice this fires at most once — but the page must
 * not depend on that, because a server that reuses is exactly what shipped.
 * </p>
 */
const NOT_ROTATED_GAP_MS = 2_000;

/**
 * How many times in a row the page will chase a code the server would not rotate.
 * Bounded, so a server that will never rotate costs a handful of requests per code
 * rather than one every two seconds for as long as the page is open.
 */
const MAX_NOT_ROTATED_TRIES = 3;

const QUIET_ZONE = 4;

/** A QR symbol for `value`, black on white regardless of theme — scanners want contrast, not tokens. */
export function QrSvg({ value, className }: { value: string; className?: string }) {
  const matrix = useMemo(() => encodeQr(value), [value]);
  const extent = matrix.size + QUIET_ZONE * 2;
  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={`QR code ${value}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={qrPath(matrix, QUIET_ZONE)} fill="#000000" />
    </svg>
  );
}

function formatStart(utc: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(utc));
}

function formatCountdown(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * The one-line meaning of a code, in the member's terms.
 *
 * <p>
 * Says which of the two codes is on screen and what it will and will not do, because
 * the two behave differently at the box and the member cannot tell them apart by
 * looking: a booking code opens one court at one time, an ident code identifies the
 * member anywhere. Presenting the wrong one is SEE THE DESK.
 * </p>
 */
function describeKind(qr: MyQrCode): { headline: string; detail: string } {
  if (qr.kind === "booking") {
    const when = qr.starts_at ? ` · starts ${formatStart(qr.starts_at)}` : "";
    return {
      headline: qr.court_number != null ? `Booking code · court ${qr.court_number}${when}` : `Booking code${when}`,
      detail: "For your booking only — it works at that court, from a few minutes before your slot until it ends. "
        + "At any other court it will not be recognised.",
    };
  }
  return {
    headline: "Walk-up code · any court",
    detail: "Identifies you at any court box: start a walk-up on a free court, or pay for someone else's time. "
      + "It is not tied to a booking.",
  };
}

// --- when a code dies -----------------------------------------------------------

/**
 * A code's expiry, on two clocks.
 *
 * <p>
 * <code>performance.now()</code> is monotonic — it cannot be dragged backwards by a
 * clock correction — but on some phones it stops while the device sleeps, which is
 * exactly when a member is not looking at this page. <code>Date.now()</code> runs
 * through sleep but can jump. Reading the expiry off both and trusting whichever says
 * less time is left means a dead code is never shown as live, whichever clock lied.
 * </p>
 */
type Deadline = { wall: number; perf: number };

function deadlineFor(seconds: number): Deadline {
  return { wall: Date.now() + seconds * 1000, perf: performance.now() + seconds * 1000 };
}

function secondsUntil(deadline: Deadline): number {
  const ms = Math.min(deadline.wall - Date.now(), deadline.perf - performance.now());
  return Math.max(0, Math.ceil(ms / 1000));
}

/**
 * What a member the club has barred sees instead of a code.
 *
 * <p>
 * The whole page, not a banner on it. Everything the normal page renders is a promise the
 * box will not keep for this member — the subtitle says the code "switches the lights on
 * and marks you as arrived", the walk-up switch offers to start on a free court or pay for
 * someone, and the QR itself is an invitation to go and hold it up at a scanner. Round 7
 * made the code inert at every box without changing any of that, so the only way to find
 * out was to stand at a court.
 * </p>
 *
 * <p>
 * The page holds this separately from its `error` state because the two are not the same
 * kind of thing: `error` is a bad minute on the network and the page goes on trying, this
 * is a decision the club has taken and the page must stop making the offer.
 * </p>
 */
function BarredCard({ reason }: { reason: string }) {
  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h1 className="text-xl font-semibold">Your court code</h1>
      <Card className="space-y-2">
        <p role="alert" className="text-sm text-danger-strong">{reason}</p>
        <p className="text-sm text-text-secondary">
          There is no code to show while that is the case, because a code would be turned away at the court.
        </p>
      </Card>
    </div>
  );
}

// --- the page -------------------------------------------------------------------

export default function CourtCodePage() {
  const [qr, setQr] = useState<MyQrCode | null>(null);
  const [deadline, setDeadline] = useState<Deadline | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** On: ask for an ident code outright, whatever bookings the member has. */
  const [walkUp, setWalkUp] = useState(false);
  /** The club has barred this member: no code to be had, and no point asking again. */
  const [barred, setBarred] = useState<string | null>(null);
  const lastFetchAt = useRef(0);
  const inflight = useRef(false);
  /** The code a pre-fetch was last made for, so the same code is not pre-fetched over and over as it runs out. */
  const prefetchedFor = useRef<string | null>(null);
  /** The code currently held, read inside the fetch — state would be a frame stale there. */
  const held = useRef<string | null>(null);
  /** Consecutive pre-fetches that answered with the code already held. See NOT_ROTATED_GAP_MS. */
  const notRotated = useRef(0);

  /**
   * Gets a code. "replace" is what the member sees happening — first load, the Refresh
   * button, the walk-up switch, or a code that died with nothing ready; "prefetch" is
   * silent, and a failure is left for the expiry path to surface, by which time it may
   * well have cleared.
   */
  const fetchCode = useCallback(async (mode: "replace" | "prefetch", kind: MyQrKind | undefined) => {
    if (inflight.current) return;
    inflight.current = true;
    lastFetchAt.current = Date.now();
    if (mode === "replace") {
      setLoading(true);
      setError(null);
    }
    try {
      const next = await endpoints.meQrGenerate(kind);
      // Did anything actually change hands? The server is entitled to answer with the
      // code the page already holds — it reuses one that has not expired — and that
      // answer is not a rotation however healthy the request looked. Counting it lets
      // the pre-fetch effect chase it instead of declaring victory over a dying QR.
      const rotated = next.code !== held.current;
      notRotated.current = mode === "prefetch" && !rotated ? notRotated.current + 1 : 0;
      held.current = next.code;
      // One batch: code, deadline and countdown move together, so no render ever shows
      // the new code with the old clock or the old code with the new one. The deadline
      // is re-read even on a reused code: the server's remaining time is the truth, and
      // it is what makes the countdown honest about how little is left.
      setQr(next);
      setDeadline(deadlineFor(next.expires_in_seconds));
      setSecondsLeft(next.expires_in_seconds);
      setError(null);
    } catch (e) {
      // Surfaced on BOTH modes. A pre-fetch is silent about every other failure, but a
      // member suspended while this page was open must not go on holding a dead code.
      const refused = describeCourtCodeRefusal(e);
      if (refused !== null) {
        setBarred(refused);
        setQr(null);
        setDeadline(null);
        setError(null);
      } else if (mode === "replace") {
        setError(
          e instanceof ApiError && e.status === 429
            ? "Too many refreshes. Give it a moment and try again."
            : "Couldn't get a code. Check your connection and try again.",
        );
      }
    } finally {
      inflight.current = false;
      if (mode === "replace") setLoading(false);
    }
  }, []);

  /** The switch. A different code is wanted now, so one is fetched now. */
  function chooseWalkUp(next: boolean) {
    setWalkUp(next);
    prefetchedFor.current = null;
    void fetchCode("replace", next ? "ident" : undefined);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom
  useEffect(() => { void fetchCode("replace", undefined); }, [fetchCode]);

  // The countdown is read off the clock, once a second while the page is visible and
  // again the moment it becomes visible. A tick that never fired — the phone was
  // locked — therefore costs nothing: the next read is right.
  useEffect(() => {
    if (!deadline) return;
    const read = () => setSecondsLeft(secondsUntil(deadline));
    const timer = setInterval(read, 1000);
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    window.addEventListener("pageshow", read);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
      window.removeEventListener("pageshow", read);
    };
  }, [deadline]);

  // The next code is fetched PREFETCH_LEAD_S before this one dies and swapped in at
  // once, so the member is never holding up a dead code. A code that has already died
  // — the pre-fetch failed, or the server handed one back already expired — is replaced
  // visibly. Both are paced so neither can turn into a request storm.
  useEffect(() => {
    if (!qr || loading || secondsLeft > PREFETCH_LEAD_S) return;
    const expired = secondsLeft === 0;
    // A pre-fetch answered with the code already on screen: nothing rotated, the member
    // is still holding one that is about to die, and waiting out the pacing gap is what
    // guarantees it dies. Try again on the short gap, a bounded number of times.
    const stalled = !expired && notRotated.current > 0;
    if (stalled && notRotated.current > MAX_NOT_ROTATED_TRIES) return;
    if (!expired && !stalled && prefetchedFor.current === qr.code) return;
    const gap = stalled ? NOT_ROTATED_GAP_MS : MIN_REFRESH_GAP_MS;
    const wait = Math.max(0, gap - (Date.now() - lastFetchAt.current));
    const kind = walkUp ? "ident" : undefined;
    const timer = setTimeout(() => {
      if (!expired) prefetchedFor.current = qr.code;
      void fetchCode(expired ? "replace" : "prefetch", kind);
    }, wait);
    return () => clearTimeout(timer);
  }, [qr, loading, secondsLeft, walkUp, fetchCode]);

  const meaning = qr ? describeKind(qr) : null;

  // Placed after every hook, so none is skipped. See BarredCard for why it replaces the
  // whole page rather than sitting beside the code.
  if (barred !== null) return <BarredCard reason={barred} />;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Your court code</h1>
        <p className="text-sm text-text-secondary">
          Show this to the scanner on the court box. It switches the lights on and marks you as arrived.
        </p>
      </div>

      {/* Without this, a member with a booking within a couple of hours is handed a
          booking code and nothing else — and a booking code is refused at every court
          but its own, so walking up to a free court or paying for a friend was a trip
          to the desk. */}
      <Card className="flex items-start gap-3 py-4">
        <input
          id="walk-up"
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0"
          checked={walkUp}
          disabled={loading}
          onChange={(e) => chooseWalkUp(e.target.checked)}
        />
        <div className="min-w-0">
          <label htmlFor="walk-up" className="text-sm font-medium">Walk up / pay for someone</label>
          <p className="text-xs text-text-muted">
            Shows the code that works at any court, even when you have a booking coming up — for starting on a
            free court now, or paying for someone else's time.
          </p>
        </div>
      </Card>

      <Card className="space-y-5">
        {error && !qr ? (
          <div className="space-y-3">
            <p className="text-sm text-danger-strong">{error}</p>
            <Button onClick={() => void fetchCode("replace", walkUp ? "ident" : undefined)} disabled={loading}>Try again</Button>
          </div>
        ) : !qr ? (
          <p className="text-sm text-text-secondary">Getting your code…</p>
        ) : (
          <>
            <div className={cn("mx-auto w-full max-w-xs transition-opacity", secondsLeft === 0 && "opacity-40")}>
              <QrSvg value={qr.code} className="w-full h-auto rounded-lg border border-border" />
            </div>

            <div className="text-center space-y-1">
              <p className="font-mono text-2xl tracking-[0.25em]" aria-label="Court code">{qr.code}</p>
              <p className="text-base font-medium">{meaning!.headline}</p>
              <p className="text-sm text-text-secondary">{meaning!.detail}</p>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-xs text-text-muted inline-flex items-center gap-1.5">
                <QrIcon size={14} />
                {secondsLeft > 0 ? `Refreshes in ${formatCountdown(secondsLeft)}` : loading ? "Refreshing…" : "Expired — refreshing"}
              </p>
              <Button
                variant="outline"
                className="h-9 px-3 text-xs"
                onClick={() => void fetchCode("replace", walkUp ? "ident" : undefined)}
                disabled={loading}
              >
                <RefreshCw size={14} className={cn("mr-1", loading && "animate-spin")} /> Refresh
              </Button>
            </div>
            {error && <p className="text-xs text-danger-strong">{error}</p>}
          </>
        )}
      </Card>
    </div>
  );
}
