import { useState } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Copy, ShareNetwork } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { playersEndpoints } from "@/lib/playersApi";
import { SHARE_LINK, playersRefusal } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { absoluteLink, copyLink, shareLink, type ShareOutcome } from "./shareLink";

/** Button icons, hoisted: 16px, decorative — the label names the action. */
const COPY_ICON = <Copy aria-hidden="true" />;
const SHARE_ICON = <ShareNetwork aria-hidden="true" />;

/**
 * A seat's invite link, handed on.
 *
 * <p>
 * <b>Two steps when the link has to be made.</b> A token is shown once and stored only hashed,
 * so "copy the link again" means a NEW link and the old one stops — the first step says so and
 * makes it. The second step holds the link on screen and shares it from a fresh tap, because a
 * phone's share sheet and clipboard both want the tap to be the member's own, not the tail of a
 * network call. A seat just added arrives with its token and starts at the second step.
 * </p>
 */
export type ShareTarget = {
  /** Who the seat is for, as the page names it — "Alex", "Open seat". */
  name: string;
  participantId: string | null;
  /** The one-time `invite_path` when the seat was just made; null to make a new one. */
  path: string | null;
};

type Props = {
  bookingId: string;
  target: ShareTarget;
  /** "Tue 30 Sep, 18:00" — for the message the share sheet carries. */
  when: string;
  onClose: () => void;
  /** A new link was made — the page re-reads. */
  onRotated: () => void;
};

export function ShareLinkDialog(props: Props) {
  const { bookingId, target, onClose, onRotated } = props;
  const [path, setPath] = useState<string | null>(target.path);
  const rotate = useAsyncAction(
    () => playersEndpoints.link(bookingId, target.participantId ?? ""),
    { success: (answer) => { setPath(answer.invite_path); onRotated(); } },
  );
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-dialog="share-link">
        {path === null ? (
          <MakeStep name={target.name} rotate={rotate} onClose={onClose} />
        ) : (
          <ReadyStep url={absoluteLink(path)} when={props.when} rotated={target.path === null} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

type Rotate = { run: () => unknown; pending: boolean; error: unknown };

function MakeStep({ name, rotate, onClose }: { name: string; rotate: Rotate; onClose: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{SHARE_LINK.confirmTitle(name)}</DialogTitle>
        <DialogDescription>{SHARE_LINK.confirmBody}</DialogDescription>
      </DialogHeader>
      {rotate.error ? (
        <DialogBody>
          <Alert tone="danger">{playersRefusal(rotate.error, { action: SHARE_LINK.makeAction })}</Alert>
        </DialogBody>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{SHARE_LINK.keep}</Button>
        <Button pending={rotate.pending} onClick={() => void rotate.run()}>{SHARE_LINK.make}</Button>
      </DialogFooter>
    </>
  );
}

const canWebShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

function ReadyStep({ url, when, rotated, onClose }: { url: string; when: string; rotated: boolean; onClose: () => void }) {
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);
  const share = async () => setOutcome(await shareLink(url, SHARE_LINK.shareTitle, SHARE_LINK.shareText(when)));
  const copy = async () => setOutcome(await copyLink(url));
  return (
    <>
      <DialogHeader>
        <DialogTitle>{SHARE_LINK.readyTitle}</DialogTitle>
        <DialogDescription>{SHARE_LINK.readyBody}</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Field>
          <FieldLabel>{SHARE_LINK.linkLabel}</FieldLabel>
          <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-sm" />
          {rotated ? <FieldDescription>{SHARE_LINK.newLinkNote}</FieldDescription> : null}
        </Field>
        {outcome === "copied" ? <Alert tone="success" live="polite">{SHARE_LINK.copied}</Alert> : null}
        {outcome === "failed" ? <Alert tone="warning">{SHARE_LINK.copyFailed}</Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{SHARE_LINK.done}</Button>
        <Button variant={canWebShare() ? "outline" : "primary"} icon={COPY_ICON} onClick={() => void copy()}>
          {SHARE_LINK.copy}
        </Button>
        {canWebShare() ? (
          <Button icon={SHARE_ICON} onClick={() => void share()}>{SHARE_LINK.share}</Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
