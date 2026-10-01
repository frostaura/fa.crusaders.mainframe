import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { statusFilterFrom, type StatusFilter } from "@/lib/membersCopy";

type Filters = { status: StatusFilter; query: string };

const NONE: Filters = { status: "all", query: "" };

function search({ status, query }: Filters): string {
  const next = new URLSearchParams();
  if (status !== "all") next.set("status", status);
  if (query) next.set("q", query);
  const text = next.toString();
  return text ? `?${text}` : "";
}

/**
 * The members list's status and search (P5 "the URL is the filter"; R4 form factor).
 *
 * <ul>
 *   <li><b>On the list itself the URL is the truth</b> — `?status=PendingApproval` from the
 *   overview's link, `?q=` kept for a shared link, Back landing where the admin left.</li>
 *   <li><b>Beside a member's record</b> the URL is the member's (`/admin/members/:userId/...`) and
 *   carries no filter, so the list keeps the last one in state: filtering the pane there narrows
 *   the pane without dragging the record's URL along, and `listHref` is the way back to the list
 *   exactly as it was left.</li>
 * </ul>
 */
export function useMembersFilters(onList: boolean) {
  const [params, setParams] = useSearchParams();
  const urlStatus = statusFilterFrom(params.get("status"));
  const urlQuery = params.get("q") ?? "";
  const [kept, setKept] = useState<Filters>({ status: urlStatus, query: urlQuery });

  // While the list is showing, what it shows is what a record opened from it should keep —
  // adjusted during render (React's "state from a changed prop"), not in an effect a frame late.
  if (onList && (kept.status !== urlStatus || kept.query !== urlQuery)) setKept({ status: urlStatus, query: urlQuery });

  const current: Filters = onList ? { status: urlStatus, query: urlQuery } : kept;

  const set = useCallback((key: "status" | "q", value: string | null) => {
    if (!onList) {
      setKept((prev) => (key === "q" ? { ...prev, query: value ?? "" } : { ...prev, status: statusFilterFrom(value) }));
      return;
    }
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  }, [onList, setParams]);

  const clear = useCallback(() => {
    if (onList) setParams(new URLSearchParams(), { replace: true });
    else setKept(NONE);
  }, [onList, setParams]);

  return { ...current, set, clear, listHref: `/admin/members${search(current)}` };
}
