import { endpoints, type AdminDevice, type MemberCodeRollout, type MemberCodeRolloutBoard } from "../../lib/api";
import { describeDeviceError } from "../../lib/deviceErrors";
import { boardName, describeRelayCourts as describeCourts } from "../../lib/deviceV3Copy";
import { versionOf } from "../settings/draft";
import { unsureSentence, writeOrReadBack } from "../../lib/lostReply";
import { LOST_REPLY, unsureWords } from "../../lib/lostReplyCopy";
import {
  PHASE_WORDS, ROLLOUT_COPY, blockingWhy, isUnacknowledged, keysLine, phaseAfter, phaseBefore, rolloutLine, rolloutState,
} from "../../lib/memberCodeRollout";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { useToast } from "../toastContext";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { StateBlock } from "../ui/state-block";
import { useServedRead } from "./useServedRead";

/**
 * Member codes › Rollout (member-code §8; FA-3, MCV1-03, MCV1-07, MCV1-09).
 *
 * <p>
 * Before this panel the club cut over to new codes by itself and nobody was shown it, and the
 * documented recovery — hold or roll back — was a raw API call. It shows the phase and what comes
 * next, every board the server says is blocking (an unacknowledged court box with
 * <i>Acknowledge</i> beside it, every blocker with <i>Take out of service</i>), the hold with who
 * set it and when, and each board's keys last sent and how many did not fit.
 * </p>
 *
 * <p>
 * The two levers are written through the settings PUT with only their own key and the version
 * read a moment before, so a colleague's settings save is never undone by this one.
 * </p>
 */
const isRollout = (data: unknown): boolean => typeof data === "object" && data !== null
  && typeof (data as MemberCodeRollout).phase === "string" && Array.isArray((data as MemberCodeRollout).blocking)
  && Array.isArray((data as MemberCodeRollout).unacknowledged);

export function MemberCodesPanel({ devices, outOfServiceWords, onChanged }: {
  devices: AdminDevice[];
  /** The page's own consequence sentence for taking this board out of service (its courts' coverage). */
  outOfServiceWords: (deviceId: string) => string;
  onChanged: () => void;
}) {
  const read = useServedRead(endpoints.adminMemberCodeRollout, isRollout);
  if (read.absent) return null;
  const changed = () => { void read.reload(); onChanged(); };
  return (
    <Card data-panel="member-codes" id="member-codes">
      <CardHeader>
        <CardTitle>Member codes</CardTitle>
        <CardDescription>The move from the old member code to the new one, board by board.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <StateBlock
          loading={read.loading && read.data === null} error={read.data === null ? read.error : null}
          action="read the member-code rollout" failedCaveat="That does not mean nothing is blocking it."
          onRetry={() => void read.reload()}
        >
          {read.data && (
            <RolloutBody rollout={read.data} devices={devices} outOfServiceWords={outOfServiceWords} onChanged={changed} />
          )}
        </StateBlock>
      </CardContent>
    </Card>
  );
}

const STATE_BADGE = {
  held: { tone: "warning", text: "Held" },
  blocked: { tone: "warning", text: "Waiting on boards" },
  clear: { tone: "success", text: "Nothing in the way" },
} as const;

function RolloutBody({ rollout, devices, outOfServiceWords, onChanged }: {
  rollout: MemberCodeRollout; devices: AdminDevice[]; outOfServiceWords: (id: string) => string; onChanged: () => void;
}) {
  const state = rolloutState(rollout);
  const badge = STATE_BADGE[state];
  return (
    <div className="flex flex-col gap-3 text-sm" data-rollout-state={state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-text-primary">{PHASE_WORDS[rollout.phase] ?? rollout.phase}</span>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </div>
      <p className="text-text-secondary">{rolloutLine(rollout)}</p>
      <p className="text-text-secondary">{`${rollout.ready_boards} of ${rollout.enabled_boards} acknowledged boards read new codes.`}</p>
      {rollout.blocking.length > 0 && (
        <ul className="flex flex-col gap-2" data-rollout-blocking="">
          {rollout.blocking.map((board) => (
            <BlockingBoard
              key={board.id} board={board} device={devices.find((d) => d.id === board.id)}
              unacknowledged={isUnacknowledged(board, rollout, devices)}
              outOfServiceWords={outOfServiceWords} onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {(rollout.keys ?? []).length > 0 && (
        <ul className="flex flex-col gap-0.5 text-text-secondary" data-rollout-keys="">
          {rollout.keys!.map((keys) => <li key={keys.id}>{keysLine(keys)}</li>)}
        </ul>
      )}
      <RolloutLevers rollout={rollout} onChanged={onChanged} />
    </div>
  );
}

function BlockingBoard({ board, device, unacknowledged, outOfServiceWords, onChanged }: {
  board: MemberCodeRolloutBoard; device: AdminDevice | undefined; unacknowledged: boolean;
  outOfServiceWords: (id: string) => string; onChanged: () => void;
}) {
  const toast = useToast();
  const name = boardName(board);
  const isGate = board.kind === "Gate";

  async function patch(req: { court_numbers?: number[]; enabled?: boolean }, holds: (row: AdminDevice) => boolean, done: string) {
    const { proven, answered } = await writeOrReadBack(
      async () => { await endpoints.adminDeviceUpdate(board.id, req); return {}; },
      async () => { const row = (await endpoints.adminDevicesList()).find((d) => d.id === board.id); return row && holds(row) ? {} : null; },
    );
    toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(done, answered) : done });
    onChanged();
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-2" data-blocking-board={board.id}>
      <p className="text-text-primary">{blockingWhy(board, unacknowledged)}</p>
      <div className="flex flex-wrap gap-2">
        {unacknowledged && !isGate && device && (
          <ConfirmDialog
            trigger={<Button size="sm" variant="outline">Acknowledge</Button>}
            title={ROLLOUT_COPY.acknowledgeTitle(name)}
            description={ROLLOUT_COPY.acknowledge(describeCourts(device.court_numbers))}
            confirmLabel="Acknowledge it"
            cancelLabel="Not yet"
            tone="primary"
            onConfirm={() => patch({ court_numbers: device.court_numbers }, (row) => !row.auto_registered, ROLLOUT_COPY.acknowledged(name))}
            action="acknowledge the board"
            describe={(e) => unsureSentence(e, unsureWords(`${name} is as it was`, `${name} was acknowledged`, "Boards"))
              ?? describeDeviceError(e, "Could not acknowledge that board.")}
          />
        )}
        {unacknowledged && isGate && <span className="text-text-secondary">Name this door on Doors to acknowledge it.</span>}
        <ConfirmDialog
          trigger={<Button size="sm" variant="danger-soft">Take out of service</Button>}
          title={ROLLOUT_COPY.disableTitle(name)}
          description={`${outOfServiceWords(board.id)} ${ROLLOUT_COPY.disable}`}
          confirmLabel="Take out of service"
          cancelLabel="Leave it in service"
          onConfirm={() => patch({ enabled: false }, (row) => !row.enabled, ROLLOUT_COPY.disabled(name))}
          action="take the board out of service"
          describe={(e) => unsureSentence(e, unsureWords(`${name} is still in service`, `${name} was taken out of service`, "Boards"))
            ?? describeDeviceError(e, "Could not take that board out of service.")}
        />
      </div>
    </li>
  );
}

function RolloutLevers({ rollout, onChanged }: { rollout: MemberCodeRollout; onChanged: () => void }) {
  const toast = useToast();
  const back = phaseBefore(rollout.phase);
  const forward = phaseAfter(rollout.phase);

  async function set(change: { member_code_manual_hold?: boolean; member_code_phase?: string }, done: string) {
    const version = versionOf(await endpoints.adminSettingsGet());
    const { proven, answered } = await writeOrReadBack(
      () => endpoints.adminMemberCodeRolloutSet(version, change),
      async () => {
        const now = await endpoints.adminMemberCodeRollout();
        const held = change.member_code_manual_hold === undefined || now.manual_hold === change.member_code_manual_hold;
        const moved = change.member_code_phase === undefined || now.phase === change.member_code_phase;
        return held && moved ? { saved: true as const } : null;
      },
    );
    toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(done, answered) : done });
    onChanged();
  }

  const unsure = (e: unknown) => unsureSentence(e, unsureWords("the rollout is as it was", "the rollout changed", "Boards"))
    ?? describeDeviceError(e, "Could not change the rollout.");

  return (
    <div className="flex flex-wrap gap-2 border-t border-border pt-3" data-rollout-levers="">
      {rollout.manual_hold ? (
        <ConfirmDialog
          trigger={<Button size="sm" variant="outline">Lift the hold</Button>}
          title={ROLLOUT_COPY.releaseTitle} description={ROLLOUT_COPY.release}
          confirmLabel="Lift the hold" cancelLabel="Keep it held" tone="primary"
          onConfirm={() => set({ member_code_manual_hold: false }, ROLLOUT_COPY.released)}
          action="lift the hold" describe={unsure}
        />
      ) : (
        <ConfirmDialog
          trigger={<Button size="sm" variant="outline">Hold the rollout</Button>}
          title={ROLLOUT_COPY.holdTitle} description={ROLLOUT_COPY.hold}
          confirmLabel="Hold it" cancelLabel="Leave it running" tone="primary"
          onConfirm={() => set({ member_code_manual_hold: true }, ROLLOUT_COPY.held)}
          action="hold the rollout" describe={unsure}
        />
      )}
      {back && (
        <ConfirmDialog
          trigger={<Button size="sm" variant="danger-soft">Go back a step</Button>}
          title={ROLLOUT_COPY.backTitle(back)} description={ROLLOUT_COPY.back}
          confirmLabel="Go back" cancelLabel="Stay where it is"
          onConfirm={() => set({ member_code_phase: back }, ROLLOUT_COPY.backDone(back))}
          action="go back a step" describe={unsure}
        />
      )}
      {forward && (
        <ConfirmDialog
          trigger={<Button size="sm" variant="ghost">Move on now</Button>}
          title={ROLLOUT_COPY.forwardTitle(forward)} description={ROLLOUT_COPY.forward(forward)}
          confirmLabel="Move on" cancelLabel="Wait"
          onConfirm={() => set({ member_code_phase: forward }, ROLLOUT_COPY.forwardDone(forward))}
          action="move the rollout on" describe={unsure}
        />
      )}
    </div>
  );
}
