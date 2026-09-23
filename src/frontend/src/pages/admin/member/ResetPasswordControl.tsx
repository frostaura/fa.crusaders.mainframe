import { useState } from "react";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { endpoints } from "@/lib/api";
import { ACCESS_COPY as COPY } from "@/lib/memberDetailCopy";

type Result = { tempPassword: string; emailed: string | null; notified: boolean };

/**
 * Reset a member's password: confirm the consequence, then show the temporary password ONCE.
 *
 * <p>
 * The password is shown even when the email went out, because "the email didn't arrive" is the
 * most common reason anybody asks the desk — and it is shown in a dialog of its own, not a toast,
 * because it has to be read aloud or copied, and a toast leaves in four seconds.
 * </p>
 */
export function ResetPasswordControl({ membershipId, name, email }: { membershipId: string; name: string; email: string }) {
  const [result, setResult] = useState<Result | null>(null);
  return (
    <>
      <ConfirmDialog
        trigger={<Button variant="outline">{COPY.resetPassword}</Button>}
        title={COPY.resetTitle(name)}
        description={COPY.resetBody(email)}
        confirmLabel={COPY.resetConfirm}
        tone="primary"
        action={COPY.resetAction}
        onConfirm={async () => {
          const r = await endpoints.adminResetMemberPassword(membershipId);
          setResult({ tempPassword: r.temp_password, emailed: r.email_sent_to, notified: r.member_notified });
        }}
      />
      <Dialog open={result !== null} onOpenChange={(next) => { if (!next) setResult(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{COPY.resetDoneTitle}</DialogTitle>
            <DialogDescription>
              {result?.notified && result.emailed ? COPY.resetDoneSent(result.emailed) : COPY.resetDoneUnsent}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="select-all break-all rounded-lg bg-bg-muted px-4 py-3 text-center font-mono text-xl tracking-code text-text-primary">
              {result?.tempPassword}
            </p>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild><Button>{COPY.close}</Button></DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
