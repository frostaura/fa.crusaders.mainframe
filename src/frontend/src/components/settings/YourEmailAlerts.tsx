import { useId } from "react";
import { EmailAlertSwitches } from "@/components/notifications/EmailAlertSwitches";
import { Envelope } from "@/components/ui/icons";
import { EMAIL_ALERTS_COPY } from "@/lib/notificationsCopy";

/**
 * "Your email alerts" — the Admin alerts section's second half (R23).
 *
 * <p>
 * <b>Set apart on purpose.</b> Everything above it in the section is the club's and rides the save
 * bar; these switches are the reader's own and save as they are flipped. A panel of its own, with
 * its own heading and the sentence saying so, is what stops an admin pressing "Save changes" and
 * wondering why their inbox choice was not in the count — or flipping one and expecting a discard
 * to undo it.
 * </p>
 */
export function YourEmailAlerts() {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-your-email-alerts=""
      className="flex flex-col gap-4 rounded-xl border border-border bg-bg-muted p-3 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="hidden size-10 shrink-0 sm:inline-flex items-center justify-center rounded-lg bg-accent-soft text-accent-strong">
          <Envelope size={20} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={titleId} className="text-base font-semibold text-text-primary">{EMAIL_ALERTS_COPY.settingsTitle}</h3>
          <p className="max-w-prose text-sm text-text-secondary">{EMAIL_ALERTS_COPY.description}</p>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-bg-surface p-3 sm:p-4">
        <EmailAlertSwitches />
      </div>
      <p className="max-w-prose text-sm text-text-secondary">{EMAIL_ALERTS_COPY.feedNote}</p>
    </section>
  );
}
