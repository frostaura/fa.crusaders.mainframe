import type { AdminMember } from "@/lib/api";
import type { StatusFilter } from "@/lib/membersCopy";

/**
 * The Members list's pure rules — which rows show, in what order, and what the chips count —
 * kept out of the components so they are tested as rules rather than through a render.
 */

/** A group, as a row names one. */
export type GroupChip = { id: string; name: string };

/**
 * One row of `GET /admin/members`, with the fields the API has added since `AdminMember` was
 * typed — every one OPTIONAL, because absent never means false: an API that predates R20 sends no
 * `is_admin`, and reading that as "not an admin" is the screen asserting something it cannot know.
 * `groups` and `last_login_at` are drawn when the list sends them and not otherwise (the member
 * detail read carries both; the list does not yet — see the lane report).
 */
export type MemberRow = AdminMember & {
  is_admin?: boolean;
  admin_source?: "config" | "granted" | null;
  groups?: GroupChip[];
  last_login_at?: string | null;
};

export type SortKey = "full_name" | "status" | "created_at" | "last_login_at" | "balance_credits";
export type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir };

export const DEFAULT_SORT: Sort = { key: "created_at", dir: "desc" };

/** A new column starts in the direction its reader expects: newest, richest, most recent first. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  const descending = key === "created_at" || key === "last_login_at" || key === "balance_credits";
  return { key, dir: descending ? "desc" : "asc" };
}

function sortValue(row: MemberRow, key: SortKey): string | number {
  if (key === "balance_credits") return row.balance_credits;
  if (key === "last_login_at") return row.last_login_at ? Date.parse(row.last_login_at) : 0;
  if (key === "created_at") return Date.parse(row.created_at) || 0;
  return String(row[key] ?? "");
}

function compare(a: MemberRow, b: MemberRow, key: SortKey): number {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
}

/** Name, email or membership number, case-insensitively. */
export function matchesSearch(row: MemberRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.full_name, row.email, row.membership_number]
    .some((field) => (field ?? "").toLowerCase().includes(q));
}

/** The rows on screen: filtered by status and search, then sorted, never mutating the input. */
export function visibleRows(rows: MemberRow[], status: StatusFilter, query: string, sort: Sort): MemberRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .filter((row) => status === "all" || row.status === status)
    .filter((row) => matchesSearch(row, query))
    .sort((a, b) => compare(a, b, sort.key) * sign);
}

export type StatusCounts = Record<StatusFilter, number>;

/**
 * What each filter chip counts. Null when the list has not been read — zero is a claim about the
 * club, and "0 pending" on a failed read once sent an admin home with applications waiting.
 */
export function statusCounts(rows: MemberRow[] | null): StatusCounts | null {
  if (!rows) return null;
  const counts: StatusCounts = { all: rows.length, PendingApproval: 0, Active: 0, Suspended: 0, Rejected: 0 };
  for (const row of rows) {
    if (row.status in counts && row.status !== "all") counts[row.status as keyof StatusCounts] += 1;
  }
  return counts;
}

/** One row replaced in place, so a sorted, filtered, scrolled table does not jump under the cursor. */
export function patchRow(rows: MemberRow[] | null, userId: string, patch: Partial<MemberRow>): MemberRow[] | null {
  if (!rows) return rows;
  return rows.map((row) => {
    if (row.user_id !== userId) return row;
    return { ...row, ...patch };
  });
}

/** Whether the list itself sends a field, so a column is drawn only when there is something to put in it. */
export function listSends(rows: MemberRow[] | null, field: "groups" | "last_login_at"): boolean {
  return (rows ?? []).some((row) => field in row);
}

/** Initials for the avatar fallback: first and last word, so a middle name never crowds. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? "" : "";
  return (first + last).toLocaleUpperCase();
}

/** The ⋯ button of the row a dialog was opened from — where focus goes back to when it closes. */
export function rowMenuOf(userId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-member-menu="${CSS.escape(userId)}"]`);
}
