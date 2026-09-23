import { useState } from "react";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Plus } from "@/components/ui/icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert } from "@/components/Alert";
import { endpoints } from "@/lib/api";
import { describeFailure } from "@/lib/errors";
import type { FingerprintEnrolment } from "@/lib/memberDetailApi";
import { ACCESS_COPY as COPY, FINGER_OPTIONS, fingerLabel } from "@/lib/memberDetailCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";

/**
 * Enrol one finger at the club's reader — consent first, then the capture.
 *
 * <p>
 * <b>Two steps because consent is not a checkbox on the way to a button.</b> The member hears
 * what is stored, where, and that they can have it deleted; the admin records that they agreed
 * (the consent receipt goes with the request); only then is the finger chosen and captured. The
 * first finger not yet enrolled is pre-chosen, so a second enrolment never silently replaces the
 * first.
 * </p>
 */
export function EnrolFingerDialog({ userId, name, used, onEnrolled }: {
  userId: string;
  name: string;
  used: FingerprintEnrolment[];
  onEnrolled: () => Promise<void>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"consent" | "capture">("consent");
  const taken = new Set(used.map((u) => u.finger_label).filter(Boolean));
  const [finger, setFinger] = useState(FINGER_OPTIONS[0].value);

  const capture = useAsyncAction(async () => {
    await endpoints.adminBiometricEnroll(userId, finger);
    toast.push({ tone: "success", text: COPY.captured(fingerLabel(finger)) });
    setOpen(false);
    await onEnrolled();
  });

  const change = (next: boolean) => {
    if (capture.pending) return;
    if (next) {
      setStep("consent");
      setFinger(FINGER_OPTIONS.find((f) => !taken.has(f.value))?.value ?? FINGER_OPTIONS[0].value);
      capture.reset();
    }
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button variant="outline" icon={<Plus weight="bold" aria-hidden="true" />}>{COPY.enrol}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{COPY.enrolTitle(name)}</DialogTitle>
          <DialogDescription>{step === "consent" ? COPY.consentStep : COPY.captureHint}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {step === "consent" ? (
            <>
              <p className="text-sm text-text-primary">{COPY.consent}</p>
              <p className="text-xs text-text-muted">{COPY.consentReceipt}</p>
            </>
          ) : (
            <Field controlId="enrol-finger">
              <FieldLabel>{COPY.finger}</FieldLabel>
              <Select value={finger} onValueChange={setFinger}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FINGER_OPTIONS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          {capture.error ? <Alert tone="danger">{describeFailure(capture.error, { action: COPY.captureAction })}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          {step === "consent" ? (
            <>
              <DialogClose asChild><Button variant="outline">{COPY.cancel}</Button></DialogClose>
              <Button onClick={() => setStep("capture")}>{COPY.consentGiven}</Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={capture.pending} onClick={() => setStep("consent")}>{COPY.back}</Button>
              <Button pending={capture.pending} onClick={() => void capture.run()}>{COPY.capture}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
