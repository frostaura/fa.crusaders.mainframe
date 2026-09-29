import { Warning } from "@/components/ui/icons";
import { GOD_MODE } from "@/lib/bookingsCopy";
import { owedBackQuoteLine } from "@/lib/playersCopy";

/**
 * R19 — god mode, said before it happens.
 *
 * <p>
 * An admin may book themselves or a member even at or below zero. The quote says whether this
 * booking `overdraws`; when it does, this notice sits above the confirm and names who goes
 * negative, by how much, and that it is on the record — "This takes Naledi to −16.00 cr. It's
 * recorded in the change record." The confirm then sends `allowNegativeBalance` deliberately.
 * It replaces the old refuse-then-retry dance, where the desk only learned about a short
 * wallet from a 402 and a second button.
 * </p>
 *
 * <p>
 * Warning, not danger: the admin is allowed to do this and it is not a mistake — it is a
 * consequence they should read. `role="status"` because it arrives after the quote is read,
 * and a screen-reader user needs to hear it before reaching the button it qualifies.
 * </p>
 *
 * <p>
 * P11: when the payer already owes partners (`owed_back_credits` on the quote), the notice says
 * so too — the next credit they get goes to those partners before it goes to this debt.
 * </p>
 */
export function GodModeNotice({ name, balanceAfter, owedBack = 0 }: { name: string | null; balanceAfter: number; owedBack?: number }) {
  return (
    <div
      role="status"
      data-god-mode=""
      className="flex items-start gap-3 rounded-xl border border-warning-strong/30 bg-warning-soft p-4 text-warning-strong"
    >
      <Warning size={20} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
      <p className="grid min-w-0 gap-0.5 text-sm">
        <span className="font-semibold">{GOD_MODE.title}</span>
        <span>{GOD_MODE.body(name, balanceAfter)}</span>
        {/* P11 — a payer who already owes partners pays them from their next credit first. */}
        {owedBack > 0 ? <span data-owed-back="">{owedBackQuoteLine(owedBack, name)}</span> : null}
      </p>
    </div>
  );
}
