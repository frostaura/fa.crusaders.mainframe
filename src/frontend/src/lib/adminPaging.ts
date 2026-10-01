import { api, type AdminMember, type LedgerRow } from "./api";

/**
 * The admin reads that page (the perf round's additive paging, switched by the PRESENCE of
 * `cursor`): `/admin/ledger/` and `/admin/members/` answer `{ items, next_cursor }` (+ `total` on
 * members, + `totals` on the ledger's first page since R4) when asked with `cursor=` — empty for
 * the first page — and the bare array otherwise. Pinned in `adminResponses.contract.test.ts`.
 */
export type Page<T> = { items: T[]; next_cursor: string | null; total?: number };

/**
 * The whole range's four figures (R4, B2; renamed by P13 §3.2): minutes in, minutes out as a
 * magnitude, net = in − out.
 */
export type LedgerTotals = { count: number; in_minutes: number; out_minutes: number; net_minutes: number };

export type LedgerPage = Page<LedgerRow> & { totals?: LedgerTotals | null };

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
export async function ledgerPage(filters: LedgerFilters, cursor = "", limit = 200): Promise<LedgerPage> {
  const answer = await api.get<LedgerPage | LedgerRow[]>(`/api/v1/admin/ledger/${query({ ...filters, cursor, limit })}`);
  return Array.isArray(answer) ? { items: answer, next_cursor: null } : answer;
}

/** The four figures over rows the page holds — only ever over a COMPLETE set. */
export function totalsOver(rows: readonly LedgerRow[]): LedgerTotals {
  const into = rows.filter((r) => r.signedAmountMinutes > 0).reduce((s, r) => s + r.amountMinutes, 0);
  const out = rows.filter((r) => r.signedAmountMinutes < 0).reduce((s, r) => s + r.amountMinutes, 0);
  return { count: rows.length, in_minutes: into, out_minutes: out, net_minutes: into - out };
}

/**
 * The range's first page and its totals (review round 4, carry-over): Transactions asked for
 * `limit=1000` and summed what came back, so a range holding 1664 movements read "MOVEMENTS 1000"
 * with credits, debits and net over a truncated set. The server now totals the whole range on the
 * first page; the rows come a page at a time ("Show more"). An API that sends no totals is read
 * to the end instead (up to `cap`), and totals are taken only over a complete read — null past it.
 */
export async function readLedgerStart(
  filters: LedgerFilters, cap = 2_000,
): Promise<{ rows: LedgerRow[]; next: string | null; totals: LedgerTotals | null }> {
  const first = await ledgerPage(filters);
  if (first.totals) return { rows: first.items, next: first.next_cursor, totals: first.totals };
  const rows = [...first.items];
  let next = first.next_cursor;
  while (next && rows.length < cap) {
    const page = await ledgerPage(filters, next, 500);
    rows.push(...page.items);
    next = page.next_cursor;
  }
  return { rows, next, totals: next ? null : totalsOver(rows) };
}

/**
 * One page of the club's members, oldest first, with each photo as a link rather than a data URI
 * (`photos=url`) — the list read every member's picture inline, the heaviest admin read there was.
 * A bare array (an API from before paging) is taken as the whole club.
 */
export async function membersPage(cursor = "", limit = 200): Promise<Page<AdminMember>> {
  const answer = await api.get<Page<AdminMember> | AdminMember[]>(`/api/v1/admin/members/${query({ cursor, limit, photos: "url" })}`);
  return Array.isArray(answer) ? { items: answer, next_cursor: null, total: answer.length } : answer;
}
