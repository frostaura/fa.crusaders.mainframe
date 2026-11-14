import { useState } from "react";
import {
  ApiError, deviceKeyBoardCount, deviceKeyBoards, endpoints, type DeviceApiKey, type DeviceKeyBoard,
} from "../../lib/api";
import { describeDeviceError } from "../../lib/deviceErrors";
import { isDeviceKey } from "../../lib/deviceProvision";
import {
  DEVICE_KEY_LINE_ID, KEY_COPY, describeV3Refusal, listBoards, retirementLine, rotationLine, typedPhrase,
} from "../../lib/deviceV3Copy";
import { unsureSentence, writeOrReadBack } from "../../lib/lostReply";
import { LOST_REPLY, unsureWords } from "../../lib/lostReplyCopy";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { useToast } from "../toastContext";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";

/**
 * Boards › Device key: rotate, watch, retire, restore (device-api §6, BA-01).
 *
 * <p>
 * <b>Why there is no Regenerate.</b> It killed the old key on the next request, and every court
 * box and door gate then needed a reflash — after the last flash, a one-click way to brick the
 * fleet. A rotation keeps every unretired key valid; boards that can rotate (`key:1`) learn the
 * new key over their heartbeat; the old key retires by itself once every board has the new one
 * and the grace has passed, and never while a board that cannot rotate is in service. Retiring
 * early is a typed confirmation naming the boards it strands. Restoring a known key is for a lost
 * database: the boards still hold the key, so the club has to be able to hold it again.
 * </p>
 */
export function KeyRotationPanel({ apiKey, onChanged }: { apiKey: DeviceApiKey; onChanged: (key: DeviceApiKey) => void }) {
  const rotation = apiKey.rotation ?? null;
  // A pre-v3 API serves neither field: no rotation surface at all, rather than one bound to nothing.
  if (apiKey.key_id === undefined && apiKey.rotation === undefined) return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-2 @[16rem]/keycard:p-3">
      {rotation ? <RotationStatus apiKey={apiKey} onChanged={onChanged} /> : <RotateControl apiKey={apiKey} onChanged={onChanged} />}
      <RestoreKey onChanged={onChanged} />
    </div>
  );
}

const focusKey = () => document.getElementById(DEVICE_KEY_LINE_ID);

function RotateControl({ apiKey, onChanged }: { apiKey: DeviceApiKey; onChanged: (key: DeviceApiKey) => void }) {
  const toast = useToast();
  async function rotate() {
    try {
      const { value, proven, answered } = await writeOrReadBack(
        () => endpoints.adminDeviceApiKeyRotate(),
        async () => { const now = await endpoints.adminDeviceApiKey(); return now.rotation ? now : null; },
      );
      onChanged(value);
      const done = KEY_COPY.rotated(value.rotation?.next_id ?? "new");
      toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(done, answered) : done, durationMs: 10000 });
    } catch (e) {
      if (e instanceof ApiError && e.code === "rotation_in_progress") {
        void endpoints.adminDeviceApiKey().then(onChanged).catch(() => undefined);
      }
      throw e;
    }
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <ConfirmDialog
        trigger={<Button variant="outline" className="self-start sm:shrink-0">Rotate key</Button>}
        title={KEY_COPY.rotateTitle}
        description={KEY_COPY.rotate}
        confirmLabel="Start the rotation"
        cancelLabel="Keep this key"
        tone="primary"
        onConfirm={rotate}
        action="start the rotation"
        describe={(e) => unsureSentence(e, unsureWords(KEY_COPY.rotateStill, KEY_COPY.rotateWhether, "the Boards page"))
          ?? describeV3Refusal(e)}
        focusAfter={focusKey}
      />
      <span className="text-sm text-text-secondary">
        {apiKey.key_id ? `Key ${apiKey.key_id}. ` : ""}Rotating changes no board by hand: they pick the new key up the next time they call in.
      </span>
    </div>
  );
}

function RotationStatus({ apiKey, onChanged }: { apiKey: DeviceApiKey; onChanged: (key: DeviceApiKey) => void }) {
  const rotation = apiKey.rotation!;
  const counts = {
    onNew: deviceKeyBoardCount(rotation.boards_on_new),
    onOld: deviceKeyBoardCount(rotation.boards_on_old),
    cannot: deviceKeyBoardCount(rotation.boards_cannot_rotate),
  };
  const named = [...deviceKeyBoards(rotation.boards_on_old), ...deviceKeyBoards(rotation.boards_cannot_rotate)];
  return (
    <div className="flex flex-col gap-2" data-key-rotation="">
      <p className="text-sm text-text-primary">{rotationLine(rotation.next_id, rotation.started_at, counts)}</p>
      {named.length > 0 && (
        <p className="text-sm text-text-secondary">Not on the new key yet: {listBoards(named)}.</p>
      )}
      <p className="text-sm text-text-secondary">{retirementLine(rotation.grace_ends_at, counts.cannot, counts.onOld)}</p>
      <RetireOldKey known={named} onChanged={onChanged} />
    </div>
  );
}

/** "Retire the old key now" — typed, and it names who it strands (§6 step 4). */
function RetireOldKey({ known, onChanged }: { known: DeviceKeyBoard[]; onChanged: (key: DeviceApiKey) => void }) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [stranded, setStranded] = useState<DeviceKeyBoard[] | null>(null);
  const boards = stranded ?? known;

  async function retire() {
    try {
      const { value } = await writeOrReadBack(
        () => endpoints.adminDeviceApiKeyRetire(typed.trim()),
        async () => { const now = await endpoints.adminDeviceApiKey(); return now.rotation ? null : now; },
      );
      onChanged(value);
      setTyped("");
      toast.push({ tone: "success", text: KEY_COPY.retired, durationMs: 10000 });
    } catch (e) {
      if (e instanceof ApiError && e.code === "boards_would_be_stranded") {
        const listed = (e.payload as { boards?: unknown }).boards;
        if (Array.isArray(listed)) setStranded(listed as DeviceKeyBoard[]);
      }
      throw e;
    }
  }

  return (
    <ConfirmDialog
      trigger={<Button variant="danger-soft" size="sm" className="self-start">Retire the old key now</Button>}
      title={KEY_COPY.retireTitle}
      description={KEY_COPY.retire}
      confirmLabel={KEY_COPY.retireLabel}
      cancelLabel="Keep both keys"
      onConfirm={retire}
      action="retire the old key"
      notReady={!typedPhrase(typed, KEY_COPY.retirePhrase)}
      notReadyMessage={KEY_COPY.retireNotReady}
      describe={(e) => unsureSentence(e, unsureWords("both keys still work", "the old key was retired", "the Boards page"))
        ?? describeV3Refusal(e)}
      focusAfter={focusKey}
    >
      {boards.length > 0 && <p className="text-sm text-danger-strong">{KEY_COPY.stranded(listBoards(boards))}</p>}
      <Field>
        <FieldLabel>{KEY_COPY.retireType} <span className="text-text-muted">(required)</span></FieldLabel>
        <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" aria-required="true" />
      </Field>
    </ConfirmDialog>
  );
}

/** "Restore a key" — owner only, typed, for a club whose database was lost (§6 step 5). */
function RestoreKey({ onChanged }: { onChanged: (key: DeviceApiKey) => void }) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [word, setWord] = useState("");
  const ready = isDeviceKey(key.trim()) && typedPhrase(word, KEY_COPY.restoreWord);

  async function restore() {
    const wanted = key.trim();
    const { value } = await writeOrReadBack(
      () => endpoints.adminDeviceApiKeyRestore(wanted, word.trim()),
      async () => { const now = await endpoints.adminDeviceApiKey(); return now.api_key === wanted ? now : null; },
    );
    onChanged(value);
    setKey("");
    setWord("");
    toast.push({ tone: "success", text: KEY_COPY.restored, durationMs: 10000 });
  }

  return (
    <ConfirmDialog
      trigger={<Button variant="ghost" size="sm" className="self-start">Restore a key</Button>}
      title={KEY_COPY.restoreTitle}
      description={KEY_COPY.restore}
      confirmLabel="Restore this key"
      cancelLabel="Cancel"
      onConfirm={restore}
      action="restore the key"
      notReady={!ready}
      notReadyMessage={key.trim() !== "" && !isDeviceKey(key.trim()) ? KEY_COPY.restoreKeyInvalid : KEY_COPY.restoreNotReady}
      describe={(e) => {
        if (e instanceof ApiError && e.status === 403 && e.code !== "demo_mode") return KEY_COPY.ownerOnly;
        return unsureSentence(e, unsureWords("the key is as it was", "the key was restored", "the Boards page"))
          ?? describeV3Refusal(e) ?? describeDeviceError(e, "Could not restore the key.");
      }}
      focusAfter={focusKey}
    >
      <Field>
        <FieldLabel>The key the boards hold <span className="text-text-muted">(required)</span></FieldLabel>
        <Input
          value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" spellCheck={false}
          aria-required="true" className="font-mono" maxLength={64}
        />
        <FieldDescription>{KEY_COPY.restoreKeyInvalid}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Type &quot;{KEY_COPY.restoreWord}&quot; to confirm <span className="text-text-muted">(required)</span></FieldLabel>
        <Input value={word} onChange={(event) => setWord(event.target.value)} autoComplete="off" aria-required="true" />
      </Field>
    </ConfirmDialog>
  );
}
