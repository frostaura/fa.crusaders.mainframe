import { useState } from "react";
import {
  endpoints, FIRMWARE_TARGETS, type AdminDevice, type FirmwareRelease, type FirmwareRollout, type FirmwareTarget,
} from "../../lib/api";
import {
  FIRMWARE_COPY, boardFirmwareProgress, boardName, describeV3Refusal, latestRelease, releaseLine, targetOf,
} from "../../lib/deviceV3Copy";
import { unsureSentence, writeOrReadBack } from "../../lib/lostReply";
import { LOST_REPLY, unsureWords } from "../../lib/lostReplyCopy";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { useToast } from "../toastContext";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { StateBlock } from "../ui/state-block";
import { useServedRead } from "./useServedRead";

/**
 * Boards › Firmware (device-api §7): signed releases for the court box's bridge and the door gate,
 * and who is offered each.
 *
 * <p>
 * <b>The server refuses an unsigned image</b> — the signature is checked against the club's
 * configured key before anything is stored — so this panel never has to judge a file. It says
 * what the API refused, in words, and shows each board's progress from its own heartbeat
 * (`fw_state`): the only evidence of what a board is actually running.
 * </p>
 *
 * <p>
 * The Mega is never a target here: it cannot be updated over WiFi, which is why the v3 Mega
 * image is the last one and the bridge steers it.
 * </p>
 */
export function FirmwarePanel({ devices, onChanged }: { devices: AdminDevice[]; onChanged: () => void }) {
  const read = useServedRead(endpoints.adminFirmwareList, Array.isArray);
  if (read.absent) return null;
  return (
    <Card data-panel="firmware">
      <CardHeader>
        <CardTitle>Firmware</CardTitle>
        <CardDescription>{FIRMWARE_COPY.lede}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <StateBlock
          loading={read.loading && read.data === null} error={read.data === null ? read.error : null}
          action="read the firmware releases" onRetry={() => void read.reload()}
        >
          {read.data && FIRMWARE_TARGETS.map((target) => (
            <TargetReleases
              key={target} target={target} releases={read.data!.filter((r) => r.target === target)}
              devices={devices.filter((d) => targetOf(d) === target)}
              onChanged={() => { void read.reload(); onChanged(); }}
            />
          ))}
          {read.data && <UploadRelease onUploaded={() => { void read.reload(); onChanged(); }} />}
        </StateBlock>
      </CardContent>
    </Card>
  );
}

function TargetReleases({ target, releases, devices, onChanged }: {
  target: FirmwareTarget; releases: FirmwareRelease[]; devices: AdminDevice[]; onChanged: () => void;
}) {
  const latest = latestRelease(releases, target);
  const progress = boardFirmwareProgress(devices, latest);
  return (
    <section className="flex flex-col gap-2" data-firmware-target={target}>
      <h4 className="text-sm font-semibold text-text-primary">{FIRMWARE_COPY.targetTitle[target]}</h4>
      {releases.length === 0 && <p className="text-sm text-text-secondary">{FIRMWARE_COPY.noReleases}</p>}
      {latest && <ReleaseControls release={latest} devices={devices} onChanged={onChanged} />}
      {releases.filter((r) => r !== latest).length > 0 && (
        <p className="text-xs text-text-muted">
          {FIRMWARE_COPY.older(releases.filter((r) => r !== latest).map((r) => r.version))}
        </p>
      )}
      {progress.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-sm text-text-secondary" data-firmware-progress="">
          {progress.map((row) => <li key={row.device.id}>{`${boardName(row.device)}: ${row.words}`}</li>)}
        </ul>
      )}
    </section>
  );
}

function ReleaseControls({ release, devices, onChanged }: { release: FirmwareRelease; devices: AdminDevice[]; onChanged: () => void }) {
  const toast = useToast();
  const [rollout, setRollout] = useState<FirmwareRollout>(release.rollout);
  const [deviceId, setDeviceId] = useState<string>(release.device_id ?? devices[0]?.id ?? "");
  const changed = rollout !== release.rollout || (rollout === "one" && deviceId !== (release.device_id ?? ""));

  async function apply(req: { rollout?: FirmwareRollout; device_id?: string | null; paused?: boolean }, done: string) {
    const { proven, answered } = await writeOrReadBack(
      () => endpoints.adminFirmwareRollout(release.id, req),
      async () => {
        const now = (await endpoints.adminFirmwareList()).find((r) => r.id === release.id);
        if (!now) return null;
        const same = (req.rollout === undefined || now.rollout === req.rollout) && (req.paused === undefined || now.paused === req.paused);
        return same ? now : null;
      },
    );
    toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(done, answered) : done });
    onChanged();
  }

  const named = devices.find((d) => d.id === deviceId);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="text-sm text-text-primary">{releaseLine(release)}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <Field className="sm:w-56">
          <FieldLabel>{FIRMWARE_COPY.offerLabel}</FieldLabel>
          <Select value={rollout} onValueChange={(v) => setRollout(v as FirmwareRollout)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{FIRMWARE_COPY.rollout.off}</SelectItem>
              <SelectItem value="one" disabled={devices.length === 0}>{FIRMWARE_COPY.rollout.one}</SelectItem>
              <SelectItem value="all">{FIRMWARE_COPY.rollout.all}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {rollout === "one" && devices.length > 0 && (
          <Field className="sm:w-56">
            <FieldLabel>{FIRMWARE_COPY.whichBoard}</FieldLabel>
            <Select value={deviceId} onValueChange={setDeviceId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {devices.map((d) => <SelectItem key={d.id} value={d.id}>{boardName(d)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        )}
        <ConfirmDialog
          trigger={<Button size="sm" disabled={!changed}>Apply</Button>}
          title={FIRMWARE_COPY.confirmTitle(release.version)}
          description={FIRMWARE_COPY.confirm(rollout, named ? boardName(named) : null)}
          confirmLabel={FIRMWARE_COPY.confirmLabel(rollout)}
          cancelLabel="Leave it"
          tone="primary"
          onConfirm={() => apply({ rollout, device_id: rollout === "one" ? deviceId : null }, FIRMWARE_COPY.applied(rollout, release.version))}
          action="change who is offered the update"
          describe={(e) => unsureSentence(e, unsureWords("the offer is as it was", "the offer changed", "the Boards page")) ?? describeV3Refusal(e)}
        />
        {release.rollout !== "off" && (
          <ConfirmDialog
            trigger={<Button size="sm" variant="outline">{release.paused ? "Resume" : "Pause"}</Button>}
            title={release.paused ? FIRMWARE_COPY.resumeTitle : FIRMWARE_COPY.pauseTitle}
            description={release.paused ? FIRMWARE_COPY.resume : FIRMWARE_COPY.pause}
            confirmLabel={release.paused ? "Resume the update" : "Pause the update"}
            cancelLabel="Leave it"
            tone="primary"
            onConfirm={() => apply({ paused: !release.paused }, release.paused ? FIRMWARE_COPY.resumed : FIRMWARE_COPY.paused)}
            action={release.paused ? "resume the update" : "pause the update"}
            describe={(e) => unsureSentence(e, unsureWords("the update is as it was", "the update changed", "the Boards page")) ?? describeV3Refusal(e)}
          />
        )}
      </div>
    </div>
  );
}

function UploadRelease({ onUploaded }: { onUploaded: () => void }) {
  const toast = useToast();
  const [image, setImage] = useState<File | null>(null);
  const [manifest, setManifest] = useState<File | null>(null);
  const [inputs, setInputs] = useState(0);

  async function upload() {
    const text = await manifest!.text();
    const named = manifestNames(text);
    const { value: release, proven, answered } = await writeOrReadBack(
      () => endpoints.adminFirmwareUpload(image!, text),
      // A lost reply: the release exists if the list now holds this target at this version.
      async () => (named ? (await endpoints.adminFirmwareList()).find((r) => r.target === named.target && r.version === named.version) ?? null : null),
    );
    const done = FIRMWARE_COPY.uploaded(release.target, release.version);
    toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(done, answered) : done });
    setImage(null);
    setManifest(null);
    setInputs((n) => n + 1);
    onUploaded();
  }

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3" data-firmware-upload="" key={inputs}>
      <h4 className="text-sm font-semibold text-text-primary">{FIRMWARE_COPY.uploadTitle}</h4>
      <Field>
        <FieldLabel>{FIRMWARE_COPY.imageLabel} <span className="text-text-muted">(required)</span></FieldLabel>
        <Input type="file" accept=".bin,application/octet-stream" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
      </Field>
      <Field>
        <FieldLabel>{FIRMWARE_COPY.manifestLabel} <span className="text-text-muted">(required)</span></FieldLabel>
        <Input type="file" accept=".json,application/json" onChange={(e) => setManifest(e.target.files?.[0] ?? null)} />
        <FieldDescription>{FIRMWARE_COPY.manifestHint}</FieldDescription>
      </Field>
      <ConfirmDialog
        trigger={<Button size="sm" className="self-start">Upload</Button>}
        title={FIRMWARE_COPY.uploadConfirmTitle}
        description={FIRMWARE_COPY.uploadConfirm}
        confirmLabel="Upload the release"
        cancelLabel="Cancel"
        tone="primary"
        onConfirm={upload}
        action="upload the release"
        notReady={image === null || manifest === null}
        notReadyMessage={FIRMWARE_COPY.uploadNotReady}
        describe={(e) => unsureSentence(e, unsureWords("nothing was uploaded", "the release was uploaded", "the Boards page")) ?? describeV3Refusal(e)}
      />
    </section>
  );
}

/** The target and version a manifest names, for the read-back; null when it is not the tool's JSON. */
function manifestNames(text: string): { target: string; version: string } | null {
  try {
    const parsed = JSON.parse(text) as { target?: unknown; version?: unknown };
    return typeof parsed.target === "string" && typeof parsed.version === "string" ? { target: parsed.target, version: parsed.version } : null;
  } catch {
    return null;
  }
}
