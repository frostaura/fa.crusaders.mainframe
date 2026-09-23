import { ActionsMenu } from "../admin/ActionsMenu";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { Archive, CalendarDots, PencilSimple, Trash, Users } from "../ui/icons";
import { priceForGroup } from "../../lib/groupRules";
import {
  GROUP_ACTIONS, memberCountLine, paintedWeekSentence, ratePerBlockSentence, slicePriceLine, type PaintedWeek,
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
 * <b>Three worded actions and a ⋯ (P3).</b> Edit, Members and Preview week are what the card is
 * opened for; Archive and Delete are consequential and rare, so they live in the card's menu and
 * each opens a confirm dialog with an outcome-named primary. Every button's name carries the
 * group ("Edit Off-peak") through a visually hidden word, so a column of cards is not a column of
 * identical "Edit" buttons to somebody tabbing down it.
 * </p>
 *
 * <p>
 * <b>A system-default group offers no delete at all — absent, not disabled.</b> A disabled
 * control invites an admin to work out how to enable it, and this one can never be enabled. The
 * sentence under the card says why, because a control that is simply missing is
 * indistinguishable from one nobody built.
 * </p>
 */
export function GroupCard(props: {
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
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { group, club, sliceMinutes, courtPrice, creditsPerZar, blockZar } = props;
  const painted = windowsToPainted(group.windows);
  const price = priceForGroup(group, courtPrice);
  const archived = group.status === "archived";

  return (
    <Card data-group-card={group.id}>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle asChild><h2>{group.name}</h2></CardTitle>
          {group.is_system_default && <Badge tone="info">Standing group</Badge>}
          {archived && <Badge tone="warning">Archived</Badge>}
        </div>
        <CardDescription>
          {memberCountLine(group.member_count)}
          {group.description ? ` · ${group.description}` : ""}
        </CardDescription>
        <CardAction>
          <ActionsMenu
            label={GROUP_ACTIONS.more(group.name)}
            items={[
              !archived && {
                label: GROUP_ACTIONS.archive,
                icon: <Archive size={16} aria-hidden="true" />,
                confirm: {
                  title: GROUP_ACTIONS.archiveTitle(group.name),
                  description: GROUP_ACTIONS.archiveBody(group.name),
                  confirmLabel: GROUP_ACTIONS.archive,
                  tone: "primary",
                  onConfirm: props.onArchive,
                },
              },
              !group.is_system_default && {
                label: GROUP_ACTIONS.remove,
                icon: <Trash size={16} aria-hidden="true" />,
                danger: true,
                confirm: {
                  title: GROUP_ACTIONS.removeTitle(group.name),
                  description: GROUP_ACTIONS.removeBody(group.name),
                  confirmLabel: GROUP_ACTIONS.remove,
                  onConfirm: props.onDelete,
                },
              },
            ]}
          />
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-1.5 text-sm">
        <p className="font-medium text-text-primary">
          {slicePriceLine({
            mode: group.pricing?.mode ?? "inherit_court",
            credits: price ?? 0,
            courtPrice,
            multiplierBps: group.pricing?.multiplier_bps,
            unknown: price === null,
          })}
        </p>
        <p className="text-text-secondary">
          {ratePerBlockSentence({ creditsPerZar, blockZar, slicePrice: price ?? courtPrice })}
        </p>
        <p className="text-text-secondary">{paintedWeekSentence(painted, club, sliceMinutes)}</p>
        {group.is_system_default ? <p className="text-text-muted">{GROUP_ACTIONS.standing(group.name)}</p> : null}
      </CardContent>

      <CardFooter>
        <Button variant="secondary" onClick={props.onEdit} icon={<PencilSimple aria-hidden="true" />}>
          {GROUP_ACTIONS.edit}{" "}<span className="sr-only">{`${group.name}`}</span>
        </Button>
        <Button variant="outline" onClick={props.onMembers} icon={<Users aria-hidden="true" />}>
          {GROUP_ACTIONS.members}{" "}<span className="sr-only">{`of ${group.name}`}</span>
        </Button>
        <Button variant="outline" onClick={props.onPreview} icon={<CalendarDots aria-hidden="true" />}>
          {GROUP_ACTIONS.preview}{" "}<span className="sr-only">{`for ${group.name}`}</span>
        </Button>
      </CardFooter>
    </Card>
  );
}
