import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QrCode as QrIcon, RefreshCw } from "lucide-react";
import { ApiError, endpoints, type MyQrCode } from "../lib/api";
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
 * code that has just died while the page fetches another.
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

/** The one-line meaning of a code, in the member's terms. */
function describeKind(qr: MyQrCode): { headline: string; detail: string } {
  if (qr.kind === "booking") {
    const when = qr.starts_at ? ` · starts ${formatStart(qr.starts_at)}` : "";
    return {
      headline: qr.court_number != null ? `Court ${qr.court_number}${when}` : `Your booking${when}`,
      detail: "This code is for your booking. It works from a few minutes before your slot until it ends.",
    };
  }
  return {
    headline: "Identifies you at any court",
    detail: "You have no booking coming up. Use this to walk up to a free court, or to pay for someone else's.",
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

// --- the page -------------------------------------------------------------------

export default function CourtCodePage() {
  const [qr, setQr] = useState<MyQrCode | null>(null);
  const [deadline, setDeadline] = useState<Deadline | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastFetchAt = useRef(0);
  const inflight = useRef(false);
  /** The code a pre-fetch was last made for, so the same code is not pre-fetched over and over as it runs out. */
  const prefetchedFor = useRef<string | null>(null);

  /**
   * Gets a code. "replace" is what the member sees happening — first load, the Refresh
   * button, or a code that died with nothing ready; "prefetch" is silent, and a failure
   * is left for the expiry path to surface, by which time it may well have cleared.
   */
  const fetchCode = useCallback(async (mode: "replace" | "prefetch") => {
    if (inflight.current) return;
    inflight.current = true;
    lastFetchAt.current = Date.now();
    if (mode === "replace") {
      setLoading(true);
      setError(null);
    }
    try {
      const next = await endpoints.meQrGenerate();
      // One batch: code, deadline and countdown move together, so no render ever shows
      // the new code with the old clock or the old code with the new one.
      setQr(next);
      setDeadline(deadlineFor(next.expires_in_seconds));
      setSecondsLeft(next.expires_in_seconds);
      setError(null);
    } catch (e) {
      if (mode === "replace") {
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

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom
  useEffect(() => { void fetchCode("replace"); }, [fetchCode]);

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
    if (!expired && prefetchedFor.current === qr.code) return;
    const wait = Math.max(0, MIN_REFRESH_GAP_MS - (Date.now() - lastFetchAt.current));
    const timer = setTimeout(() => {
      if (!expired) prefetchedFor.current = qr.code;
      void fetchCode(expired ? "replace" : "prefetch");
    }, wait);
    return () => clearTimeout(timer);
  }, [qr, loading, secondsLeft, fetchCode]);

  const meaning = qr ? describeKind(qr) : null;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Your court code</h1>
        <p className="text-sm text-text-secondary">
          Show this to the scanner on the court box. It switches the lights on and marks you as arrived.
        </p>
      </div>

      <Card className="space-y-5">
        {error && !qr ? (
          <div className="space-y-3">
            <p className="text-sm text-danger-strong">{error}</p>
            <Button onClick={() => void fetchCode("replace")} disabled={loading}>Try again</Button>
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
              <Button variant="outline" className="h-9 px-3 text-xs" onClick={() => void fetchCode("replace")} disabled={loading}>
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
