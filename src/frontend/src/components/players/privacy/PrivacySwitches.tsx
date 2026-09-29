import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { WarningCircle } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StateBlock } from "@/components/ui/state-block";
import { Switch } from "@/components/ui/switch";
import { PRIVACY_COPY as COPY } from "@/lib/playersCopy";
import { PRIVACY_KEYS, PRIVACY_LABEL, usePrivacyPrefs, type PrivacyKey, type PrivacyPrefs } from "./usePrivacyPrefs";

/**
 * D13 — "Let other members find me" and "Show me on leaderboards", both off by default.
 *
 * <p>
 * <b>One component, two doors</b>: the welcome wizard's privacy step and Profile's Privacy card
 * both render THIS, so the two can never disagree about a switch. Each saves the moment it is
 * flipped — it is the member's own preference, not a form.
 * </p>
 */
export function PrivacySwitches() {
  const prefs = usePrivacyPrefs();
  const { read } = prefs;
  return (
    <StateBlock
      loading={read.loading && read.data === null}
      error={read.data === null ? read.error : null}
      action={COPY.readAction}
      onRetry={prefs.retry}
      skeleton={<SwitchesSkeleton />}
    >
      {read.data ? (
        <ul data-privacy-switches="" className="flex flex-col divide-y divide-border">
          {PRIVACY_KEYS.map((key) => <PrivacyRow key={key} which={key} prefs={prefs} />)}
        </ul>
      ) : null}
    </StateBlock>
  );
}

function PrivacyRow({ which, prefs }: { which: PrivacyKey; prefs: PrivacyPrefs }) {
  const { label, hint } = PRIVACY_LABEL[which];
  const pending = prefs.pending(which);
  const error = prefs.error(which);
  return (
    <li data-privacy={which} className="py-3 first:pt-0 last:pb-0">
      <Field className="grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <FieldLabel className="break-words">{label}</FieldLabel>
          <FieldDescription className="break-words">{hint}</FieldDescription>
        </div>
        <div className="col-start-2 row-span-full flex min-h-touch items-center gap-2">
          {pending ? <Spinner className="text-text-secondary" label={COPY.saving} /> : null}
          <Switch
            checked={prefs.value(which)}
            aria-busy={pending || undefined}
            onCheckedChange={(next) => { if (!pending) void prefs.set(which, next); }}
          />
        </div>
      </Field>
      {/* The rollback, said where it happened. role=alert: the switch moving back is not news on its own. */}
      {error ? (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm font-medium text-danger-strong">
          <WarningCircle size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : null}
    </li>
  );
}

function SwitchesSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-4">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <Skeleton className="h-6 w-11 rounded-full" />
        </div>
      ))}
    </div>
  );
}
