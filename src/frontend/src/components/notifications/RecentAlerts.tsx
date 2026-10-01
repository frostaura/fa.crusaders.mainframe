import { useId, useRef, useState, type Ref } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Bell, CaretRight, Clock, Coins, Door, Receipt, Repeat, ShieldCheck, ShieldWarning, UserPlus, Warning,
  WebhooksLogo, WifiHigh, WifiSlash, type Icon,
} from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { ApiError } from "@/lib/api";
import { clubInstant } from "@/lib/clubClock";
import type { AdminNotice } from "@/lib/notificationsApi";
import { RECENT_ALERTS_COPY as COPY, deliveryBadge, noticeAge } from "@/lib/notificationsCopy";
import { useTicker } from "@/lib/useTicker";
import { cn } from "@/lib/utils";
import type { RecentAlertsFeed } from "./useRecentAlerts";

/**
 * The Overview's "Recent alerts" (R23): what every admin was emailed about, newest first, with
 * whether the email went. It is the record behind the inbox — an admin who switched a kind off
 * still finds it here, and an admin who never got an email can see whether one was sent.
 *
 * <p>
 * <b>Four honest states</b>: a skeleton shaped like the rows while the first page is out; a failed
 * read with a retry that says what it does NOT mean; "No alerts yet" only for a read that answered
 * with nothing; then the rows, with "Show older alerts" for as long as the server has a cursor.
 * An older page that fails leaves the rows above it standing and says so beside the button.
 * </p>
 */

/** Each kind's mark — a cue beside the words, never instead of them. Unknown kinds get the bell. */
const KIND_ICON: Record<string, Icon> = {
  "member.registered": UserPlus,
  "member.application_pending": Clock,
  "device.offline": WifiSlash,
  "device.recovered": WifiHigh,
  "device.fault_spike": Warning,
  "door.refusal_spike": Door,
  // A package purchase that needs looking at (the code keeps its name, P13 §5).
  "topup.failed": Receipt,
  "webhook.auto_disabled": WebhooksLogo,
  "schedule.conflict": Repeat,
  "booking.overdraft_authorised": Coins,
  "admin.role_changed": ShieldCheck,
  "code.forgery_suspected": ShieldWarning,
};

export function RecentAlerts({ feed, shown }: {
  feed: RecentAlertsFeed;
  /**
   * How many to draw before "See all" (R5 A5-6). The rest open IN PLACE — there is no other page of
   * alerts — and focus goes to the first one revealed. Older pages are offered only once all the
   * rows already read are showing, so "Show older alerts" never fetches past rows still hidden.
   */
  shown?: number;
}) {
  // "5 min ago" moves with the clock; a minute is finer than anybody reads it.
  const now = useTicker(true, 60_000);
  const [all, setAll] = useState(false);
  const firstRevealed = useRef<HTMLLIElement>(null);
  const folded = !all && shown !== undefined && feed.items.length > shown;
  const items = folded ? feed.items.slice(0, shown) : feed.items;
  const seeAll = () => {
    // Drawn first, then focused: the button goes with the fold, and focus must not fall to <body>.
    flushSync(() => setAll(true));
    const row = firstRevealed.current;
    row?.querySelector<HTMLElement>("a, [tabindex]")?.focus();
  };
  return (
    <StateBlock
      loading={feed.loading}
      error={feed.error}
      action={COPY.readAction}
      failedCaveat={COPY.readCaveat}
      onRetry={feed.retry}
      empty={feed.answered && feed.items.length === 0}
      emptyIcon={Bell}
      emptyTitle={COPY.emptyTitle}
      emptyHint={COPY.emptyHint}
      skeleton={<AlertsSkeleton />}
    >
      <ol
        aria-label={COPY.listLabel}
        data-recent-alerts=""
        className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-surface shadow-xs"
      >
        {items.map((notice, index) => (
          <AlertRow key={notice.id} notice={notice} now={now} rowRef={index === shown ? firstRevealed : undefined} />
        ))}
      </ol>
      {folded ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={seeAll}>{COPY.seeAll(feed.items.length)}</Button>
        </div>
      ) : null}
      {feed.more.error ? (
        <Alert tone="danger">{isCursorExpired(feed.more.error) ? COPY.cursorExpired : COPY.loadMoreFailed}</Alert>
      ) : null}
      {feed.cursor && !folded ? (
        <div className="flex justify-center">
          <Button variant="outline" pending={feed.more.pending} onClick={() => void feed.more.run()}>{COPY.loadMore}</Button>
        </div>
      ) : null}
    </StateBlock>
  );
}

function isCursorExpired(error: unknown): boolean {
  return error instanceof ApiError && error.code === "cursor_invalid";
}

/** An internal console path — the only kind of link a notice may open from here. */
function consolePath(link: string | null): string | null {
  return link && link.startsWith("/") && !link.startsWith("//") ? link : null;
}

/**
 * One alert: its kind's mark, the headline (the row's name), the kind and when (its description),
 * and how the email went. The whole row is ONE link to where it is dealt with, when there is one.
 */
function AlertRow({ notice, now, rowRef }: { notice: AdminNotice; now: number; rowRef?: Ref<HTMLLIElement> }) {
  const KindIcon = KIND_ICON[notice.kind] ?? Bell;
  const badge = deliveryBadge(notice.delivery);
  const to = consolePath(notice.link);
  const headlineId = useId();
  const metaId = useId();
  const body = (
    <>
      {/* R5 X4-6: the 40px (rem) tile left the headline 116px at 390/200 % text, and "membership"
          broke mid-word. A rem container query is a large-text query: the tile goes when the ROW is
          under 16rem (256px at normal text, 512px at 200 %). */}
      <span aria-hidden="true" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-bg-muted text-text-secondary [@container(max-width:16rem)]:hidden">
        <KindIcon size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={headlineId} className="break-words font-semibold text-text-primary">{notice.headline}</span>
        <span id={metaId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
          <span className="break-words">{notice.title}</span>
          {/* The dot travels with the time, so a wrap never strands it at a line's start. */}
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <span aria-hidden="true">·</span>
            {/* The comma for a screen reader, and a REAL space after it: name computation trims a
                child's own trailing space. */}
            <span className="sr-only">,</span>{" "}
            <time dateTime={notice.created_at} title={clubInstant(notice.created_at)}>{noticeAge(notice.created_at, now)}</time>
          </span>
          <span className="sr-only">{`. ${badge.label}.`}</span>
        </span>
        <span aria-hidden="true" className="flex"><Badge tone={badge.tone} data-delivery={notice.delivery.state}>{badge.label}</Badge></span>
      </span>
      {to ? <CaretRight size={16} weight="bold" aria-hidden="true" className="mt-3 shrink-0 text-text-muted" /> : null}
    </>
  );
  const row = "flex min-h-touch w-full items-start gap-3 px-4 py-3 text-left";
  return (
    <li ref={rowRef} data-alert={notice.kind} className="[container-type:inline-size]">
      {to ? (
        // Named by the headline, described by the kind, the age and the delivery — not one run-on
        // name made of the whole row.
        <Link to={to} aria-labelledby={headlineId} aria-describedby={metaId} className={cn(row, "no-underline transition-colors duration-fast ease-standard hover:bg-bg-muted motion-reduce:transition-none")}>
          {body}
        </Link>
      ) : (
        // Focusable by script only, so "See all" can land on a revealed row that links nowhere.
        <div className={row} tabIndex={-1}>{body}</div>
      )}
    </li>
  );
}

function AlertsSkeleton() {
  return (
    <div className="flex flex-col divide-y divide-border rounded-xl border border-border" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="size-10 shrink-0" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
