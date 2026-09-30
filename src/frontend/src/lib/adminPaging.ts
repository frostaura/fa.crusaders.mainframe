import { api, type LedgerRow } from "./api";

/**
 * The admin reads that page (the perf round's additive paging, switched by the PRESENCE of
 * `cursor`): `/admin/ledger/` and `/admin/members/` answer `{ items, next_cursor }` (+ `total` on
 * members) when asked with `cursor=` — empty for the first page — and the bare array otherwise.
 * Pinned against the C# handlers in `adminResponses.contract.test.ts`.
 */
export type Page<T> = { items: T[]; next_cursor: string | null; total?: number };

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") q.set(key, String(value));
  }
  // `cursor` is sent even when empty: its presence is what asks for a page.
  if (!q.has("cursor")) q.set("cursor", "");
  return `?${q.toString()}`;
}

export type LedgerFilters = { from?: string; to?: string; userId?: string; type?: string };

/** One page. A bare array (an API from before paging) is taken as the whole answer. */
export async function ledgerPage(filters: LedgerFilters, cursor = "", limit = 500): Promise<Page<LedgerRow>> {
  const answer = await api.get<Page<LedgerRow> | LedgerRow[]>(`/api/v1/admin/ledger/${query({ ...filters, cursor, limit })}`);
  return Array.isArray(answer) ? { items: answer, next_cursor: null } : answer;
}

/**
 * Every movement in the range, page by page (review round 4, carry-over): Transactions asked for
 * `limit=1000` and summed what came back, so a range holding 1664 movements read "MOVEMENTS 1000"
 * with credits, debits and net over a truncated set. Totals are only ever taken over a complete
 * read; `cap` stops a runaway range, and the caller says so when it is reached.
 */
export async function readWholeLedger(
  filters: LedgerFilters, options: { cap?: number; onPage?: (rows: LedgerRow[]) => void } = {},
): Promise<{ rows: LedgerRow[]; complete: boolean }> {
  const cap = options.cap ?? 20_000;
  const rows: LedgerRow[] = [];
  let cursor = "";
  for (;;) {
    const page = await ledgerPage(filters, cursor);
    rows.push(...page.items);
    options.onPage?.(rows.slice());
    if (!page.next_cursor) return { rows, complete: true };
    if (rows.length >= cap) return { rows, complete: false };
    cursor = page.next_cursor;
  }
}
