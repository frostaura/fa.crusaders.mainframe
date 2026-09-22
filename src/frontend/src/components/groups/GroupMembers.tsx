import { useState } from "react";
import { Button } from "../Button";
import { Card } from "../Card";
import { StateBlock } from "../StateBlock";
import { clubDayAndClock } from "../../lib/clubClock";
import { addMembersLabel, addResultLine, memberCountLine } from "../../lib/groupsCopy";
import type { AdminBulkResult, MemberGroup } from "../../lib/adminApi";

/**
 * Who is in this group, and the two ways somebody gets in or out — D3 §6.5, route 1.
 *
 * <p>
 * <b>The result of a batch is a SCREEN, not a toast.</b> `POST /member-groups/{id}/members`
 * answers per item, so the answer is shown per item: four seconds is not long enough to read
 * six outcomes, the toast viewport deliberately carries no live region of its own, and "already
 * in this group" is not a failure — which a succeeded/failed count cannot express at all.
 * </p>
 *
 * <p>
 * <b>The action is named with the number and the group.</b> "Add selected" on a page with four
 * groups on it is a control an admin presses to find out what it does.
 * </p>
 */

export type ClubMember = { user_id: string; full_name: string; membership_number?: string | null };

export function GroupMembers({
  group, clubMembers, current, loading, error, result, adding, onAdd, onRemove, onRetry, onClose,
  timezone,
}: {
  group: MemberGroup;
  /** Everybody the club has, for choosing from. */
  clubMembers: ClubMember[];
  /** Who is in the group now, as the API answers it. */
  current: Array<{ user_id: string; name: string; membership_number?: string | null; added_at?: string; added_by_name?: string | null }>;
  loading: boolean;
  error: unknown;
  result: AdminBulkResult | null;
  adding: boolean;
  onAdd: (userIds: string[]) => void;
  onRemove: (userId: string) => void;
  onRetry: () => void;
  onClose: () => void;
  timezone: string | undefined;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const inGroup = new Set(current.map((m) => m.user_id));
  const candidates = clubMembers.filter((m) => !inGroup.has(m.user_id));
  const chosen = [...selected].filter((id) => candidates.some((m) => m.user_id === id));
  const nameOf = (id: string) =>
    clubMembers.find((m) => m.user_id === id)?.full_name ?? "Somebody the club no longer has";

  const toggle = (id: string) => setSelected((now) => {
    const next = new Set(now);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{`Members of ${group.name}`}</h2>
        <span className="text-sm text-text-secondary">{memberCountLine(group.member_count)}</span>
        <Button variant="ghost" className="ml-auto min-h-11" onClick={onClose}>Close</Button>
      </div>

      {result && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <h3 className="text-base font-semibold" aria-live="polite">
            {`${result.succeeded} of ${result.requested} done.`}
          </h3>
          <ul className="space-y-1 text-sm">
            {result.results.map((row) => (
              <li
                key={row.id}
                className={row.status === "failed" ? "text-danger-strong" : "text-text-secondary"}
              >
                {row.status === "failed" ? "✗ " : "✓ "}
                {addResultLine(row, nameOf(row.id))}
              </li>
            ))}
          </ul>
          {result.failed > 0 && (
            <Button
              variant="outline" className="min-h-11"
              onClick={() => onAdd(result.results.filter((r) => r.status === "failed").map((r) => r.id))}
            >
              {`Try the ${result.failed} that failed`}
            </Button>
          )}
        </div>
      )}

      <StateBlock
        loading={loading}
        error={error}
        action="read who is in this group"
        failedCaveat="That does not mean nobody is."
        onRetry={onRetry}
        empty={!loading && !error && current.length === 0}
        emptyTitle={`Nobody is in ${group.name} yet. Its rules apply to nobody until somebody is added.`}
      >
        <ul className="space-y-2">
          {current.map((member) => (
            <li key={member.user_id} className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
              <span className="min-w-0 break-words text-sm text-text-primary">{member.name}</span>
              {member.membership_number && (
                <span className="text-sm text-text-muted">{member.membership_number}</span>
              )}
              {member.added_at && (
                <span className="text-xs text-text-muted">
                  {`Added ${clubDayAndClock(member.added_at, timezone)}`}
                  {member.added_by_name ? ` by ${member.added_by_name}` : ""}
                </span>
              )}
              <Button
                variant="ghost" className="ml-auto min-h-11"
                onClick={() => onRemove(member.user_id)}
              >
                {`Take ${member.name} out of ${group.name}`}
              </Button>
            </li>
          ))}
        </ul>
      </StateBlock>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-text-primary">Add somebody</h3>
        <ul className="space-y-1">
          {candidates.map((member) => (
            <li key={member.user_id}>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox" className="h-5 w-5"
                  checked={selected.has(member.user_id)}
                  onChange={() => toggle(member.user_id)}
                />
                <span>{member.full_name}</span>
                {member.membership_number && (
                  <span className="text-text-muted">{member.membership_number}</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      </div>

      {chosen.length > 0 && (
        // The selection strip. Not a modal and not a toast: the list stays on screen, because
        // the decision being made is about the list.
        <div
          role="region"
          aria-label={`Selected for ${group.name}`}
          className="flex flex-wrap items-center gap-3 rounded-lg bg-bg-muted p-3"
        >
          <p className="text-sm font-medium">
            {chosen.length === 1 ? "1 member selected" : `${chosen.length} members selected`}
          </p>
          <Button
            variant="primary" className="min-h-11" disabled={adding}
            onClick={() => { onAdd(chosen); setSelected(new Set()); }}
          >
            {addMembersLabel(chosen.length, group.name)}
          </Button>
          <Button variant="ghost" className="min-h-11" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}
    </Card>
  );
}
