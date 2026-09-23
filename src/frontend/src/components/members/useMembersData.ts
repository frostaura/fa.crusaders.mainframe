import { useCallback, useEffect, useRef, useState } from "react";
import { endpoints, type BiometricEnrollmentRow } from "@/lib/api";
import { adminEndpoints } from "@/lib/adminApi";
import { notifyPendingApplicationsChanged } from "@/lib/pendingApplications";
import type { GroupChip, MemberRow } from "./membersModel";

/**
 * The club's members as the list needs them, with the read's failure kept separate.
 *
 * <p>
 * <b>An empty list on a failed read is not an answer.</b> `members` stays `null` until a read
 * succeeds and `error` holds why it did not, so the screen can say "the list could not be read"
 * rather than "No members yet." — the second is what a club of two hundred once looked like with
 * the toast that contradicted it already faded.
 * </p>
 *
 * <p>
 * <b>Always the whole club, never `?status=`.</b> The filter is applied on screen so every chip
 * can carry its count; a server-side filter would leave the other four chips unable to say
 * anything true about themselves.
 * </p>
 */
export function useMembersList() {
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [readAt, setReadAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await endpoints.adminMembers();
      setMembers(rows as MemberRow[]);
      setReadAt(Date.now());
      // The one place the pending set is known to have moved, because this is the one place it
      // is re-read. Notifying from the loader rather than from Approve/Reject is what keeps the
      // chrome's badge and this screen's Pending count incapable of disagreeing — including when
      // an approval the server committed was reported as failed (see lib/pendingApplications).
      notifyPendingApplicationsChanged();
    } catch (err) {
      // State only, no toast: the panel says it for as long as the screen is wrong.
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; its sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

  return { members, setMembers, loading, error, readAt, load };
}

export type GroupsState =
  | { status: "loading" }
  | { status: "ready"; byUser: Map<string, GroupChip[]> }
  | { status: "failed" }
  /** The list carries `groups` itself; nothing to read. */
  | { status: "inline" };

const PAGE = 200;

async function membersOfGroup(group: GroupChip): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  // Bounded: a cursor that never ends is a server fault, not a reason to spin.
  for (let page = 0; page < 50; page += 1) {
    const r = await adminEndpoints.memberGroupMembers(group.id, { cursor, limit: PAGE });
    for (const m of r.members ?? []) ids.push(m.user_id);
    if (!r.cursor) break;
    cursor = r.cursor;
  }
  return ids;
}

async function readMemberships(): Promise<Map<string, GroupChip[]>> {
  const { groups } = await adminEndpoints.memberGroups();
  const active = (groups ?? []).filter((g) => g.status !== "archived");
  const byUser = new Map<string, GroupChip[]>();
  const lists = await Promise.all(active.map(async (g) => ({ g, ids: await membersOfGroup(g) })));
  for (const { g, ids } of lists) {
    for (const id of ids) byUser.set(id, [...(byUser.get(id) ?? []), { id: g.id, name: g.name }]);
  }
  return byUser;
}

/**
 * Which groups each member is in — from the list when it sends them, otherwise from the groups'
 * own member lists. A failure is its own state: the column is hidden and the page says why,
 * because a blank Groups cell reads as "in no group".
 */
export function useGroupMemberships(inline: boolean) {
  const [state, setState] = useState<GroupsState>({ status: "loading" });
  const seq = useRef(0);

  const read = useCallback(async () => {
    const mine = ++seq.current;
    setState({ status: "loading" });
    try {
      const byUser = await readMemberships();
      if (mine === seq.current) setState({ status: "ready", byUser });
    } catch {
      if (mine === seq.current) setState({ status: "failed" });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; its sync loading flag is the house idiom
    if (!inline) void read();
  }, [inline, read]);

  const shown: GroupsState = inline ? { status: "inline" } : state;
  return { state: shown, retry: read };
}

/**
 * Fingerprint enrolments by member. Best effort: the count only decides a menu item's wording, and
 * the dialog that manages them re-reads on every change.
 */
export function useFingerprints() {
  const [byUser, setByUser] = useState<Record<string, BiometricEnrollmentRow>>({});
  const read = useCallback(async () => {
    try {
      const rows = await endpoints.adminBiometricEnrollments();
      const map: Record<string, BiometricEnrollmentRow> = {};
      for (const row of rows) map[row.user_id] = row;
      setByUser(map);
    } catch { /* non-blocking */ }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; the state is set when the read answers
  useEffect(() => { void read(); }, [read]);
  return { byUser, read };
}
