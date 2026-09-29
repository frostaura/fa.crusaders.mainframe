import { useCallback, useState } from "react";
import { LedgerTable } from "@/components/LedgerTable";
import { LedgerDetailSheet } from "@/components/admin/LedgerDetailSheet";
import type { Column } from "@/components/wallet/ledgerColumns";
import type { LedgerRow } from "@/lib/api";

/** F3.8: who made each movement and what kind it was, and every row opens. */
const COLUMNS: Column[] = ["time", "category", "actor", "comment", "amount"];
import { Button } from "@/components/ui/button";
import { Plus, Receipt } from "@/components/ui/icons";
import { Section } from "@/components/ui/page-shell";
import { StateBlock } from "@/components/ui/state-block";
import { TableSkeleton } from "@/components/monitoring/parts";
import { endpoints } from "@/lib/api";
import { LEDGER_LIMIT, MEMBER_COPY, WALLET_TAB_COPY as COPY } from "@/lib/memberDetailCopy";
import { useRead } from "@/lib/useRead";
import { useMemberDetail } from "./useMemberDetail";

/**
 * Wallet & ledger — this member's movements, and the one way to move their credit by hand.
 *
 * <p>
 * <b>Top up goes through the header's sheet</b>, not a second copy of it here: one idempotency key
 * per intended movement is only a guarantee if there is one place that mints it.
 * </p>
 *
 * <p>
 * <b>The ledger re-reads whenever the balance changes</b> — a top-up from this tab or the header,
 * or a Refresh — so the rows under the figure are always the rows that sum to it. It is keyed on
 * the balance and the read instant rather than refetched by a callback, because a callback that
 * somebody forgets to call is how a wallet shows a balance its own ledger does not add up to.
 * </p>
 */
export function MemberWallet() {
  const { detail, name, userId, readAt, openTopUp } = useMemberDetail();
  const load = useCallback(() => endpoints.adminLedger({ userId, limit: LEDGER_LIMIT }), [userId]);
  const [ledger, retry] = useRead(`${userId}:${detail.balance_credits}:${readAt ?? 0}`, load);
  const rows = ledger.data ?? [];
  const [opened, setOpened] = useState<LedgerRow | null>(null);

  return (
    // Top up lives on the header right above this tab, once; a second copy here would be two
    // buttons for one action. An EMPTY ledger offers it again, where it is the next step.
    <Section title={COPY.title} description={COPY.description}>
      <StateBlock
        loading={ledger.loading}
        error={ledger.error}
        action={COPY.loadAction}
        failedCaveat={COPY.failedCaveat}
        onRetry={retry}
        empty={!ledger.loading && !ledger.error && rows.length === 0}
        emptyIcon={Receipt}
        emptyTitle={COPY.empty}
        emptyHint={COPY.emptyHint}
        emptyAction={<Button onClick={openTopUp} icon={<Plus weight="bold" aria-hidden="true" />}>{MEMBER_COPY.topUp}</Button>}
        skeleton={<TableSkeleton rows={5} />}
      >
        <div className="overflow-hidden rounded-xl border border-border bg-bg-surface">
          <LedgerTable rows={rows} columns={COLUMNS} onOpen={setOpened} label={COPY.label(name)} />
        </div>
        {rows.length >= LEDGER_LIMIT ? <p className="text-sm text-text-muted">{COPY.showingLatest(rows.length)}</p> : null}
      </StateBlock>
      <LedgerDetailSheet row={opened} onClose={() => setOpened(null)} />
    </Section>
  );
}
