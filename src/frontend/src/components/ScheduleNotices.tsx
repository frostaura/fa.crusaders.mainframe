import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Info, WarningCircle, X } from "@/components/ui/icons";
import { cn } from "../lib/utils";
import { BOOKINGS_COPY } from "../lib/bookingsCopy";
import type { Notice } from "../lib/gridExplain";

/**
 * The standing conditions above the grid, the explanation a locked cell gave, and the one live
 * region the grid speaks through.
 *
 * <p>
 * <b>`role="status"`, never `role="alert"`.</b> Every notice here is a condition the member
 * ARRIVED into — their quota is used up, their groups' windows do not overlap, their wallet is
 * empty. None of it is an event, and a screen that shouts a standing fact is the defect
 * `lib/announce` was written to close. <b>`warning`, never `danger`:</b> reaching the club's
 * daily cap is the rule working, not a mistake.
 * </p>
 *
 * <p>
 * <b>The live region is separate and always mounted.</b> A region rendered conditionally
 * announces on mount, which is how a screen ends up re-reading a banner every time a poll swaps a
 * payload. The visible explanation beside it is `aria-hidden` text, because one press must
 * produce exactly one announcement; its × is outside the hidden text so it stays reachable.
 * </p>
 *
 * <p>
 * <b>Links navigate, buttons act.</b> "Top up" goes somewhere, so it is a router link wearing the
 * button's look (`<Button asChild><Link/></Button>`); "Try tomorrow" changes the page, so it is a
 * button.
 * </p>
 */
export function ScheduleNotices(props: {
  notices: Notice[];
  live: string;
  shown: string;
  onDismiss: () => void;
  onNextDay?: () => void;
}) {
  const { notices, live, shown, onDismiss, onNextDay } = props;
  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">{live}</div>
      {shown.trim() ? (
        <div data-grid-explanation="" className="flex items-start gap-3 rounded-xl border border-info-strong/20 bg-info-soft py-1 pl-3 pr-1 text-info-strong">
          <Info size={20} aria-hidden="true" className="mt-2.5 shrink-0" />
          <p aria-hidden="true" className="min-w-0 flex-1 py-2.5 text-sm">{shown}</p>
          <IconButton label={BOOKINGS_COPY.dismissExplanation} onClick={onDismiss} className="shrink-0 text-info-strong hover:bg-bg-surface/60">
            <X aria-hidden="true" />
          </IconButton>
        </div>
      ) : null}
      {notices.map((n) => (
        <div
          key={n.id}
          role="status"
          className={cn(
            "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border p-3 sm:items-center sm:p-4",
            n.tone === "warning" ? "border-warning-strong/30 bg-warning-soft text-warning-strong" : "border-info-strong/20 bg-info-soft text-info-strong",
          )}
        >
          {/* The shape differs with the tone, so a calm note never wears a warning's mark. */}
          {n.tone === "warning"
            ? <WarningCircle size={20} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0 sm:mt-0" />
            : <Info size={20} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0 sm:mt-0" />}
          <div className="min-w-0 flex-1 basis-48">
            <p className="text-sm font-semibold">{n.title}</p>
            {n.body ? <p className="mt-1 text-sm">{n.body}</p> : null}
          </div>
          <NoticeAction notice={n} onNextDay={onNextDay} />
        </div>
      ))}
    </>
  );
}

function NoticeAction({ notice, onNextDay }: { notice: Notice; onNextDay?: () => void }) {
  const action = notice.action;
  if (action?.to) {
    return (
      <Button asChild variant="outline" size="sm" className="ml-auto shrink-0">
        <Link to={action.to}>{action.label}</Link>
      </Button>
    );
  }
  if (action?.nextDay && onNextDay) {
    return <Button variant="outline" size="sm" onClick={onNextDay} className="ml-auto shrink-0">{action.label}</Button>;
  }
  return null;
}
