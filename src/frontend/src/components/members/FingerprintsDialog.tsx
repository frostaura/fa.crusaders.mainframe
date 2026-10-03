import { useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useToast } from "@/components/toastContext";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Fingerprint, X } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { endpoints, type BiometricTemplateRow } from "@/lib/api";
import { FINGERPRINTS as COPY, FINGER_OPTIONS } from "@/lib/membersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";

/**
 * A member's fingerprints on the club's reader — list, remove, and enrol with consent. (P5)
 *
 * <p>
 * Three phases, because enrolment is three separate facts: what is enrolled now, that the member
 * agreed (the consent receipt is recorded with the admin's id), and the capture itself. The finger
 * is a closed Select — the reader keys templates by it, and a typed one is a template nobody can
 * find again. Every remove and the capture carry a real pending state, not a frozen button.
 * </p>
 */
type Phase = "manage" | "consent" | "capturing";

export type FingerprintsDialogProps = {
  member: { user_id: string; full_name: string };
  templates: BiometricTemplateRow[];
  onClose: () => void;
  /** Re-read the enrolments; resolves once the list is fresh. */
  onChange: () => Promise<void>;
};

export function FingerprintsDialog({ member, templates, onClose, onChange }: FingerprintsDialogProps) {
  const [phase, setPhase] = useState<Phase>("manage");
  const [finger, setFinger] = useState<string>("right-index");

  const startEnrol = () => {
    const used = new Set(templates.map((t) => t.finger_label).filter(Boolean) as string[]);
    setFinger(FINGER_OPTIONS.find((f) => !used.has(f)) ?? "right-index");
    setPhase("consent");
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{COPY.title(member.full_name)}</DialogTitle>
          <DialogDescription>{COPY.description}</DialogDescription>
        </DialogHeader>
        {phase === "manage" ? (
          <ManagePhase member={member} templates={templates} onChange={onChange} onClose={onClose} onEnrol={startEnrol} />
        ) : null}
        {phase === "consent" ? <ConsentPhase onBack={() => setPhase("manage")} onAgree={() => setPhase("capturing")} /> : null}
        {phase === "capturing" ? (
          <CapturePhase
            member={member}
            finger={finger}
            setFinger={setFinger}
            onBack={() => setPhase("consent")}
            onCaptured={async () => { await onChange(); setPhase("manage"); }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ManagePhase({ member, templates, onChange, onClose, onEnrol }: Omit<FingerprintsDialogProps, "onClose"> & {
  onClose: () => void; onEnrol: () => void;
}) {
  const toast = useToast();
  const removeAll = async () => {
    try {
      await Promise.all(templates.map((t) => endpoints.adminBiometricRemoveTemplate(t.template_id)));
      await onChange();
      toast.push({ tone: "success", text: COPY.allRemoved(member.full_name) });
    } catch { toast.push({ tone: "danger", text: COPY.allRemoveFailed }); }
  };
  return (
    <>
      <DialogBody>
        {templates.length === 0 ? (
          <p className="text-sm text-text-secondary">{COPY.none}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-overline text-text-muted">{COPY.enrolled}</p>
            <ul className="flex flex-wrap gap-2">
              {templates.map((t) => <FingerChip key={t.template_id} template={t} onChange={onChange} />)}
            </ul>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        {templates.length > 0 ? (
          <ConfirmButton idleLabel={COPY.removeAll} confirmLabel={COPY.removeAllConfirm} onConfirm={removeAll} tone="danger" />
        ) : null}
        <Button variant="outline" onClick={onClose}>{COPY.done}</Button>
        <Button variant="secondary" onClick={onEnrol} icon={<Fingerprint aria-hidden="true" />}>
          {templates.length ? COPY.add : COPY.enrol}
        </Button>
      </DialogFooter>
    </>
  );
}

function FingerChip({ template, onChange }: { template: BiometricTemplateRow; onChange: () => Promise<void> }) {
  const label = template.finger_label ?? COPY.unspecified;
  const remove = useAsyncAction(async () => {
    await endpoints.adminBiometricRemoveTemplate(template.template_id);
    await onChange();
  }, { toast: { success: COPY.removed, failure: COPY.removeFailed } });
  return (
    <li className="inline-flex items-center gap-1 rounded-full border border-border bg-info-soft py-0.5 pl-3 pr-0.5 text-sm font-medium text-info-strong">
      <Fingerprint size={16} aria-hidden="true" />
      <span className="font-mono text-xs">{label}</span>
      <IconButton label={COPY.remove(label)} size="icon-sm" pending={remove.pending} onClick={() => void remove.run()}>
        <X aria-hidden="true" />
      </IconButton>
    </li>
  );
}

function ConsentPhase({ onBack, onAgree }: { onBack: () => void; onAgree: () => void }) {
  return (
    <>
      <DialogBody className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-text-primary">{COPY.consentTitle}</p>
        <blockquote className="rounded-xl border border-border bg-bg-muted p-4 text-sm text-text-primary">{COPY.consent}</blockquote>
        <p className="text-xs text-text-muted">{COPY.consentReceipt}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onBack}>{COPY.back}</Button>
        <Button onClick={onAgree}>{COPY.acknowledged}</Button>
      </DialogFooter>
    </>
  );
}

function CapturePhase({ member, finger, setFinger, onBack, onCaptured }: {
  member: { user_id: string; full_name: string };
  finger: string;
  setFinger: (f: string) => void;
  onBack: () => void;
  onCaptured: () => Promise<void>;
}) {
  const capture = useAsyncAction(async () => {
    await endpoints.adminBiometricEnroll(member.user_id, finger);
    await onCaptured();
  }, { toast: { success: COPY.enrolledToast(member.full_name, finger), failure: COPY.enrolFailed } });
  return (
    <>
      <DialogBody className="flex flex-col gap-4">
        <Field>
          <FieldLabel>{COPY.fingerLabel}</FieldLabel>
          <Select value={finger} onValueChange={setFinger}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FINGER_OPTIONS.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <p className="text-sm text-text-secondary">{COPY.place}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onBack}>{COPY.back}</Button>
        <Button onClick={() => void capture.run()} pending={capture.pending} icon={<Fingerprint aria-hidden="true" />}>
          {COPY.capture}
        </Button>
      </DialogFooter>
    </>
  );
}
