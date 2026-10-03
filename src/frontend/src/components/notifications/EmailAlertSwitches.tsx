import { useCallback, useId, useState } from "react";
import { useToast } from "@/components/toastContext";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Lock } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StateBlock } from "@/components/ui/state-block";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api";
import { describeFailure } from "@/lib/errors";
import { notificationsEndpoints, type AdminNoticeKind } from "@/lib/notificationsApi";
import { EMAIL_ALERTS_COPY as COPY, lockedBecause, whoIsStillTold } from "@/lib/notificationsCopy";
import { cn } from "@/lib/utils";
import { useRead } from "@/lib/useRead";

/**
 * An admin's own email alerts (R23: "all admins must receive emails for things like new member
 * requests") — one switch per kind the notifier raises, drawn from the server's catalogue.
 *
 * <p>
 * <b>Shared by Settings and Profile</b>, because it is one preference with two doors: Settings is
 * where an admin tunes how the club alerts; Profile is where anybody looks for "my emails". Both
 * render THIS, so the two can never disagree about a switch.
 * </p>
 *
 * <p>
 * <b>Each switch saves the moment it is flipped</b> — it is the caller's own preference, not a club
 * setting, so it does not ride the Settings save bar. The flip is optimistic; a refusal puts the
 * switch back, says so, and re-reads the catalogue so the screen shows what the server holds. The
 * write is the WHOLE opt-out list (the contract replaces rather than patches), built from what the
 * screen shows at the moment of the flip, so two quick flips do not undo each other.
 * </p>
 *
 * <p>
 * <b>The kinds nobody may switch off are shown, locked, with the reason beside them.</b> Hiding
 * them would let an admin believe they had silenced everything; a disabled switch with no reason
 * reads as broken.
 * </p>
 */
export function EmailAlertSwitches() {
  const [read, retry] = useRead("notification-kinds", notificationsEndpoints.kinds);
  const alerts = useOptOuts(read.data, retry);

  return (
    <StateBlock
      loading={read.loading && read.data === null}
      error={read.data === null ? read.error : null}
      action={COPY.readAction}
      failedCaveat={COPY.readCaveat}
      onRetry={retry}
      skeleton={<SwitchesSkeleton />}
    >
      {read.data ? (
        <ul data-email-alerts="" className="flex flex-col divide-y divide-border">
          {read.data.map((kind) => (
            <KindRow
              key={kind.kind}
              kind={kind}
              on={!alerts.isOff(kind)}
              pending={alerts.pending.has(kind.kind)}
              onChange={(next) => void alerts.set(kind, next)}
            />
          ))}
        </ul>
      ) : null}
    </StateBlock>
  );
}

/** The optimistic layer over the catalogue: flips not yet confirmed, and which are in flight. */
function useOptOuts(kinds: AdminNoticeKind[] | null, reread: () => void) {
  const toast = useToast();
  // kind → the value the admin asked for (true = off). Kept after a success, so a re-read that
  // races the write cannot flick the switch back; dropped on a refusal.
  const [wanted, setWanted] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const isOff = useCallback(
    (kind: AdminNoticeKind) => kind.optional && (wanted.get(kind.kind) ?? kind.opted_out),
    [wanted],
  );

  const mark = (key: string, busy: boolean) => setPending((current) => {
    const copy = new Set(current);
    if (busy) copy.add(key); else copy.delete(key);
    return copy;
  });

  const set = async (kind: AdminNoticeKind, on: boolean) => {
    if (!kinds || !kind.optional || pending.has(kind.kind)) return;
    // Built from what the screen shows now, so a second flip carries the first one with it.
    const next = new Map(wanted).set(kind.kind, !on);
    setWanted(next);
    mark(kind.kind, true);
    const optouts = kinds.filter((row) => row.optional && (next.get(row.kind) ?? row.opted_out)).map((row) => row.kind);
    try {
      await notificationsEndpoints.setOptouts(optouts);
      toast.push({ tone: "success", text: on ? COPY.switchedOn(kind.title) : COPY.switchedOff(kind.title) });
    } catch (error) {
      setWanted((current) => {
        const copy = new Map(current);
        copy.delete(kind.kind);
        return copy;
      });
      // "Nothing changed" only when the server said no: a timeout may have landed, and the
      // re-read below is what settles which.
      toast.push({ tone: "danger", text: failureText(error, kind.title), unchanged: error instanceof ApiError, durationMs: 8000 });
      reread();
    } finally {
      mark(kind.kind, false);
    }
  };

  return { isOff, pending, set };
}

function failureText(error: unknown, title: string): string {
  return describeFailure(error, {
    action: `change the ${title.charAt(0).toLowerCase()}${title.slice(1)} email`,
    codes: { notification_kind_not_optional: COPY.notOptional(title) },
    fallback: COPY.saveFailed(title),
  });
}

type KindRowProps = { kind: AdminNoticeKind; on: boolean; pending: boolean; onChange: (on: boolean) => void };

function KindRow({ kind, on, pending, onChange }: KindRowProps) {
  const reasonId = useId();
  return (
    // R5 X5-5: beside an 88px switch and a 32px gap (both rem) the words had ~120px at 390 / 200 %
    // and broke mid-word. When the ROW is under 20rem (320px at normal text, 640px at 200 %) the
    // switch goes under the words, which then have the row's whole width.
    <li data-alert-kind={kind.kind} className="py-3 [container-type:inline-size] first:pt-0 last:pb-0">
      <Field className="grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 [@container(max-width:20rem)]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <FieldLabel className="break-words">{kind.title}</FieldLabel>
          <FieldDescription className="break-words">{kind.description}</FieldDescription>
          {kind.optional ? null : (
            <p id={reasonId} className="mt-1 flex items-start gap-1.5 text-sm font-medium text-text-primary">
              <Lock size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0 text-text-secondary" />
              <span>{`${COPY.alwaysOn}. ${lockedBecause(kind.kind)}`}</span>
            </p>
          )}
          {kind.optional && !on ? <StillTold othersReceiving={kind.others_receiving} /> : null}
        </div>
        <div className="col-start-2 row-span-full flex min-h-touch items-center gap-2 [@container(max-width:20rem)]:col-start-1 [@container(max-width:20rem)]:[grid-row:auto]">
          {pending ? <Spinner className="text-text-secondary" label={COPY.saving} /> : null}
          {kind.optional ? (
            <Switch
              checked={on}
              aria-busy={pending || undefined}
              onCheckedChange={(next) => { if (!pending) onChange(next); }}
            />
          ) : (
            // Locked ON: a real switch that says so (aria-disabled keeps it in the tab order, so a
            // screen reader still meets it and hears why), never a missing one.
            <Switch checked aria-disabled="true" aria-describedby={reasonId} className="cursor-not-allowed" onCheckedChange={() => undefined} />
          )}
        </div>
      </Field>
    </li>
  );
}

/** F3.11: switching an alert off says, at the switch, whether anybody is still emailed it. */
function StillTold({ othersReceiving }: { othersReceiving: number | undefined }) {
  const said = whoIsStillTold(othersReceiving);
  return (
    <p
      data-still-told={said.nobody ? "nobody" : ""}
      role={said.nobody ? "status" : undefined}
      className={cn("mt-1 text-sm", said.nobody ? "font-medium text-warning-strong" : "text-text-secondary")}
    >
      {said.text}
    </p>
  );
}

function SwitchesSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-4">
          {/* R4 form factor: min-w-0 + max-w-full — a 12rem bar is 384px at 200 % text, and it pushed
              a 390 phone sideways while the switches were read. */}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}
