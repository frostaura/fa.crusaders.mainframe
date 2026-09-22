import { Badge, Button } from "../Button";
import { Card } from "../Card";
import { ConfirmButton } from "../ConfirmButton";
import { priceForGroup } from "../../lib/groupRules";
import {
  memberCountLine, paintedWeekSentence, ratePerBlockSentence, slicePriceLine, type PaintedWeek,
} from "../../lib/groupsCopy";
import { windowsToPainted } from "./weekGrid";
import type { MemberGroup } from "../../lib/adminApi";

/**
 * One group, summarised in the four facts an admin opens this page for.
 *
 * <p>
 * <b>What it costs and when it applies are on the CARD, not behind the editor.</b> A list of
 * group names tells an admin nothing they did not already know; the reason to come here is to
 * find out which rule is doing the thing somebody has complained about, and that answer has to
 * be readable without opening anything.
 * </p>
 *
 * <p>
 * <b>A system-default group offers no delete at all — absent, not disabled.</b> A disabled
 * control invites an admin to work out how to enable it, and this one can never be enabled. The
 * sentence beside it says why, because a control that is simply missing is indistinguishable
 * from one nobody built.
 * </p>
 */
export function GroupCard({
  group, club, sliceMinutes, courtPrice, creditsPerZar, blockZar,
  onEdit, onMembers, onPreview, onArchive, onDelete,
}: {
  group: MemberGroup;
  club: PaintedWeek;
  sliceMinutes: number;
  courtPrice: number;
  creditsPerZar: number | null | undefined;
  blockZar: number | null | undefined;
  onEdit: () => void;
  onMembers: () => void;
  onPreview: () => void;
  onArchive: () => void | string | Promise<void | string>;
  onDelete: () => void | string | Promise<void | string>;
}) {
  const painted = windowsToPainted(group.windows);
  const price = priceForGroup(group, courtPrice);
  const archived = group.status === "archived";

  return (
    <Card className="space-y-3">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <h2 className="min-w-0 break-words text-lg font-semibold">{group.name}</h2>
        {group.is_system_default && <Badge tone="info">Standing group</Badge>}
        {archived && <Badge tone="warning">Archived</Badge>}
        <span className="ml-auto text-sm text-text-secondary">{memberCountLine(group.member_count)}</span>
      </div>

      {group.description && <p className="min-w-0 break-words text-sm text-text-secondary">{group.description}</p>}

      <p className="text-sm text-text-primary">
        {slicePriceLine({
          mode: group.pricing?.mode ?? "inherit_court",
          credits: price ?? 0,
          courtPrice,
          multiplierBps: group.pricing?.multiplier_bps,
          unknown: price === null,
        })}
      </p>
      <p className="text-sm text-text-secondary">
        {ratePerBlockSentence({ creditsPerZar, blockZar, slicePrice: price ?? courtPrice })}
      </p>
      <p className="text-sm text-text-secondary">{paintedWeekSentence(painted, club, sliceMinutes)}</p>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11" onClick={onEdit}>{`Edit ${group.name}`}</Button>
        <Button variant="outline" className="min-h-11" onClick={onMembers}>{`Members of ${group.name}`}</Button>
        <Button variant="outline" className="min-h-11" onClick={onPreview}>
          {`Preview ${group.name}'s week`}
        </Button>
        {!archived && (
          <ConfirmButton
            idleLabel="Archive this group"
            cancelLabel="Leave it applying"
            confirmLabel={`${group.name} stops applying to anybody. Nothing is deleted and it can be brought back.`}
            ariaLabel={group.name}
            subject={group.name}
            onConfirm={onArchive}
            className="min-h-11"
          />
        )}
        {group.is_system_default ? (
          <p className="w-full text-sm text-text-muted">
            {`${group.name} is one of the club's two standing groups. It can be renamed and edited, `}
            and it cannot be deleted — so this screen always has two rows to explain the feature with.
          </p>
        ) : (
          <ConfirmButton
            idleLabel="Delete this group"
            cancelLabel="Keep it"
            tone="danger"
            confirmLabel={`${group.name} is removed for good. The club refuses this while anybody is still in it.`}
            ariaLabel={group.name}
            subject={group.name}
            onConfirm={onDelete}
            className="min-h-11"
          />
        )}
      </div>
    </Card>
  );
}
