import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { describeFailure, isDeploymentFault } from "@/lib/errors";
import { Alert } from "../Alert";
import { Button } from "./button";
import { WarningCircle, type Icon } from "./icons";

/**
 * The honest read, restyled (design-system.md, Patterns → Async actions): failed · loading ·
 * empty · stale · the thing itself — in that order of precedence, always.
 *
 * <p>
 * <b>The API is a superset of `components/StateBlock.tsx`</b>, so that file can become a
 * re-export of this one without touching a call site. Every rule it carried is kept: an empty
 * collection is not an answer (failed wins over empty and over children); failed wins over
 * loading so a retry is not snatched away by a poll; no retry for a deployment fault; stale is
 * a band above real content, never a fifth state, and never claimed without a time.
 * </p>
 *
 * <p>
 * <b>What is new.</b> `skeleton` — a read screen shows a layout-shaped Skeleton, never
 * "Loading…"; the region is `aria-busy` and the sentence naming what is being read moves into a
 * visually hidden status. `emptyIcon` (40px duotone) and `emptyAction` for an empty state that
 * tells a member what to do next. The retry is the new `Button`, outline, 44px.
 * </p>
 */
export type StateBlockProps = {
  /** The first read has not answered yet. */
  loading?: boolean;
  /** What was thrown, or null — whole, so `isDeploymentFault` can drop the retry. */
  error?: unknown;
  /** The verb phrase after "Couldn't" / "Reading" — "read the fault list". */
  action?: string;
  /** Error codes this endpoint can return, with the sentence for each. */
  codes?: Record<string, string>;
  /** What is NOT true because the read failed — "That does not mean there are none." */
  failedCaveat?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** The read succeeded and returned nothing. Never inferred from a length. */
  empty?: boolean;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  /** A Phosphor icon from the barrel, drawn 40px duotone above the title. */
  emptyIcon?: Icon;
  /** The next step — usually one Button or TextLink. */
  emptyAction?: ReactNode;
  /** A layout-shaped `<Skeleton>` tree shown while loading. */
  skeleton?: ReactNode;
  /** When this was read, already in the club's clock. */
  readAt?: string | null;
  stale?: boolean;
  staleHint?: string;
  className?: string;
  children?: ReactNode;
};

type Failed = Pick<StateBlockProps, "error" | "action" | "codes" | "failedCaveat" | "onRetry" | "retryLabel" | "className">;

function FailedState(props: Failed) {
  const { error, action, codes, failedCaveat, onRetry, retryLabel = "Try again", className } = props;
  const retry = onRetry && !isDeploymentFault(error);
  return (
    <div data-state-block="error" className={cn("flex flex-col items-start gap-3", className)}>
      <Alert tone="danger" className="w-full">
        {describeFailure(error, { action, codes })}
        {failedCaveat ? ` ${failedCaveat}` : ""}
      </Alert>
      {retry ? <Button variant="outline" onClick={onRetry}>{retryLabel}</Button> : null}
    </div>
  );
}

function LoadingState({ action, skeleton, className }: Pick<StateBlockProps, "action" | "skeleton" | "className">) {
  const sentence = action ? `Reading ${action}…` : "Reading…";
  if (!skeleton) {
    return <p role="status" data-state-block="loading" className={cn("text-sm text-text-secondary", className)}>{sentence}</p>;
  }
  return (
    <div data-state-block="loading" aria-busy="true" className={className}>
      <p role="status" className="sr-only">{sentence}</p>
      {skeleton}
    </div>
  );
}

type Empty = Pick<StateBlockProps, "emptyTitle" | "emptyHint" | "emptyIcon" | "emptyAction" | "className">;

function EmptyState({ emptyTitle, emptyHint, emptyIcon: EmptyIcon, emptyAction, className }: Empty) {
  return (
    <div data-state-block="empty" className={cn("flex flex-col items-center gap-2 px-4 py-10 text-center", className)}>
      {EmptyIcon ? <EmptyIcon size={40} weight="duotone" aria-hidden="true" className="text-text-muted" /> : null}
      <p className="text-base font-semibold text-text-primary">{emptyTitle ?? "Nothing here yet."}</p>
      {emptyHint ? <div className="max-w-prose text-sm text-text-secondary">{emptyHint}</div> : null}
      {emptyAction ? <div className="mt-2">{emptyAction}</div> : null}
    </div>
  );
}

function StaleBand({ readAt, staleHint }: { readAt: string; staleHint?: string }) {
  return (
    <p data-state-block="stale" className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning-strong">
      <WarningCircle size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {`Read at ${readAt}.`}
        {staleHint ? ` ${staleHint}` : ""}
      </span>
    </p>
  );
}

export function StateBlock(props: StateBlockProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { loading = false, error = null, empty = false, readAt, stale = false, staleHint, className, children } = props;
  // 1. Failed, first and always — an empty state over a failed read invents an answer.
  if (error) return <FailedState {...props} />;
  // 2. Still asking.
  if (loading) return <LoadingState action={props.action} skeleton={props.skeleton} className={className} />;
  // 3. Genuinely nothing, and the call site said so.
  if (empty) return <EmptyState {...props} />;
  // 4. The thing itself — under a band when it is stale AND we can say when it was read.
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {stale && readAt ? <StaleBand readAt={readAt} staleHint={staleHint} /> : null}
      {children}
    </div>
  );
}
