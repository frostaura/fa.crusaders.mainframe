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
 */

/** The API's auth rate limit is ten calls a minute per member; a refresh loop must stay well under it. */
const MIN_REFRESH_GAP_MS = 10_000;

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

export default function CourtCodePage() {
  const [qr, setQr] = useState<MyQrCode | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastFetchAt = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await endpoints.meQrGenerate();
      lastFetchAt.current = Date.now();
      setQr(next);
      setSecondsLeft(next.expires_in_seconds);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 429
          ? "Too many refreshes. Give it a moment and try again."
          : "Couldn't get a code. Check your connection and try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom
  useEffect(() => { void load(); }, [load]);

  // One tick a second. The server's expires_in_seconds is the truth; this only counts it down.
  useEffect(() => {
    if (!qr) return;
    const timer = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [qr]);

  // A code that has run out is replaced without anyone tapping anything — a member at
  // the box should never be holding up a dead code. Paced so a code the server hands
  // back already expired cannot turn this into a request storm.
  useEffect(() => {
    if (!qr || loading || secondsLeft > 0) return;
    const wait = Math.max(0, MIN_REFRESH_GAP_MS - (Date.now() - lastFetchAt.current));
    const timer = setTimeout(() => void load(), wait);
    return () => clearTimeout(timer);
  }, [qr, loading, secondsLeft, load]);

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
            <Button onClick={() => void load()} disabled={loading}>Try again</Button>
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
              <Button variant="outline" className="h-9 px-3 text-xs" onClick={() => void load()} disabled={loading}>
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
