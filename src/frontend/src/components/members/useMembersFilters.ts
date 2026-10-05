import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { statusFilterFrom, type StatusFilter } from "@/lib/membersCopy";
import { useUrlText } from "@/lib/useUrlText";

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
 *   <li><b>The search field owns what was typed</b> (R15 L15-2): `?q=` is written once typing pauses
 *   (`useUrlText`), and the list filters on the typed text at once. Writing the URL per key lost
 *   keys typed before the router committed — "bartholomew" came out "brtholomew".</li>
 * </ul>
 */
export function useMembersFilters(onList: boolean) {
  const [params, setParams] = useSearchParams();
  const urlStatus = statusFilterFrom(params.get("status"));
  const urlQuery = params.get("q") ?? "";
  const [kept, setKept] = useState<Filters>({ status: urlStatus, query: urlQuery });

  const writeQuery = useCallback((value: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set("q", value); else next.delete("q");
      return next;
    }, { replace: true });
  }, [setParams]);
  const [typed, setTyped] = useUrlText(urlQuery, writeQuery);

  // While the list is showing, what it shows is what a record opened from it should keep —
  // adjusted during render (React's "state from a changed prop"), not in an effect a frame late.
  if (onList && (kept.status !== urlStatus || kept.query !== typed)) setKept({ status: urlStatus, query: typed });

  const current: Filters = onList ? { status: urlStatus, query: typed } : kept;

  const set = useCallback((key: "status" | "q", value: string | null) => {
    if (!onList) {
      setKept((prev) => (key === "q" ? { ...prev, query: value ?? "" } : { ...prev, status: statusFilterFrom(value) }));
      return;
    }
    if (key === "q") {
      setTyped(value ?? "");
      return;
    }
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  }, [onList, setParams, setTyped]);

  const clear = useCallback(() => {
    if (onList) setParams(new URLSearchParams(), { replace: true });
    else setKept(NONE);
  }, [onList, setParams]);

  return { ...current, set, clear, listHref: `/admin/members${search(current)}` };
}
