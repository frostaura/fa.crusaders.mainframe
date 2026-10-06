import { useEffect, useState } from "react";
import { endpoints } from "@/lib/api";
import { OTHER_BOOKING, recentBookingsFrom, type RecentBooking } from "@/lib/deskLedger";
import { ledgerCategory } from "@/lib/ledgerCopy";
import { RELATED_BOOKING as COPY } from "@/lib/membersCopy";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { InfoPopover } from "@/components/ui/info-popover";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * The optional booking a credit adjustment is compensation for.
 *
 * <p>
 * Naming the booking is what turns a manual credit from plain money into evidence. It does
 * <b>not</b> stand in for the automatic reversal: a no-show is reversed on its own the moment the
 * box's attendance upload arrives. What naming it does is make the hand adjustment part of the
 * arithmetic — settlement-model I3 nets it against the reversal <em>one leg at a time</em>:
 * </p>
 *
 * <pre>
 * penaltyBack = max(0, penalised − Σ  positive adjustments naming b)
 * refundBack  = max(0, refunded  − Σ |negative adjustments naming b|)
 * </pre>
 *
 * <p>
 * The copy has been wrong about this twice (first "a credit is the repair for a wrongly-recorded
 * no-show", then "a credit on top leaves them holding both"), so the whole rule is one tap away
 * in an InfoPopover rather than a paragraph under the field — de-cluttered, never dropped.
 * </p>
 *
 * <p>
 * The booking must be this member's own. The picker offers only theirs (from the ledger filtered
 * to them — every charge, penalty and refund row names its booking); a typed id is checked for
 * shape by the caller; ownership and existence are the server's, and its two refusals come back
 * as `error`, shown here at the field.
 * </p>
 */
const NONE = "none";

export function RelatedBookingField(
  { userId, value, error, onChange }: { userId: string; value: string; error: string | null; onChange: (next: string) => void },
) {
  const [recent, setRecent] = useState<RecentBooking[] | null>(null);
  // Seeded from the value the page still holds, so stepping Back to this field shows the booking
  // that is actually about to be sent — not a blank picker over a remembered id.
  const [choice, setChoice] = useState(() => (value ? value : NONE));

  useEffect(() => {
    let cancelled = false;
    // Best effort: the field degrades to "type the ID" if the ledger cannot be read.
    endpoints.adminLedger({ userId, limit: 50 })
      // R18 E18-9 — each row in the ledger page's own words: a returned penalty says "returned".
      .then((rows) => { if (!cancelled) setRecent(recentBookingsFrom(rows, ledgerCategory)); })
      .catch(() => { if (!cancelled) setRecent([]); });
    return () => { cancelled = true; };
  }, [userId]);

  const pick = (next: string) => {
    setChoice(next);
    onChange(next === OTHER_BOOKING || next === NONE ? "" : next);
  };

  // A remembered id the ledger does not list was typed by hand: show it as the typed option.
  const listed = recent === null || recent.some((b) => b.id === choice);
  const shown = choice === NONE || choice === OTHER_BOOKING || listed ? choice : OTHER_BOOKING;

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel>{COPY.label}</FieldLabel>
          <InfoPopover label={COPY.moreLabel} className="-my-2">
            <p>{COPY.more}</p>
          </InfoPopover>
        </div>
        <Select value={shown} onValueChange={pick}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{COPY.none}</SelectItem>
            {recent === null ? <SelectItem value="loading" disabled>{COPY.loading}</SelectItem> : null}
            {(recent ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.label}</SelectItem>)}
            <SelectItem value={OTHER_BOOKING}>{COPY.other}</SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>{COPY.short}</FieldDescription>
        <FieldError>{shown === OTHER_BOOKING ? null : error}</FieldError>
      </Field>
      {shown === OTHER_BOOKING ? (
        <Field>
          <FieldLabel>{COPY.idLabel}</FieldLabel>
          <Input
            className="font-mono"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={COPY.idPlaceholder}
            autoComplete="off"
          />
          <FieldDescription>{COPY.otherHint}</FieldDescription>
          <FieldError>{error}</FieldError>
        </Field>
      ) : null}
    </div>
  );
}
