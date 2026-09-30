import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { SignOut } from "@/components/ui/icons";
import { endpoints } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { SIGN_OUT_EVERYWHERE_COPY as COPY } from "@/lib/profileCopy";
import { RevokePasskeysSwitch } from "./RevokePasskeysSwitch";

/** What `/login` is handed after a sign-out everywhere, so it can say what happened. */
export type SignedOutNotice = { signedOutNotice: string };

/**
 * "Sign out everywhere" (member-code §10): every session the member has ends — THIS ONE
 * INCLUDED — and their code rotates. The passkeys stay unless they ask, because a member signing
 * out a forgotten tablet should not lose the passkey on the phone in their hand.
 *
 * <p>
 * <b>The token that asked is dead once the server answers</b>, so a success ends the session
 * here with `signedOutEverywhere` — `logout`'s local half, the member code's key wiped with it —
 * and never with `logout`, whose server call would be refused. `/login` then says what happened
 * rather than presenting a blank form. A refusal stays in the dialog, and the session with it.
 * </p>
 */
export function SignOutEverywhere() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [revokePasskeys, setRevokePasskeys] = useState(false);

  const confirm = async () => {
    const r = await endpoints.revokeAllSessions(revokePasskeys);
    const state: SignedOutNotice = { signedOutNotice: COPY.done(r.passkeys_revoked, r.passkeys_removed) };
    // The sentence rides on the provider (D7): in the real app the auth reset re-renders the
    // guarded page first and its redirect to /login overtook router state every time.
    auth.signedOutEverywhere(state.signedOutNotice);
    navigate("/login", { replace: true, state });
  };

  return (
    <ConfirmDialog
      trigger={<Button variant="outline" icon={<SignOut weight="bold" />} className="h-auto min-h-touch max-w-full whitespace-normal py-2">{COPY.open}</Button>}
      title={COPY.confirmTitle}
      description={COPY.confirmBody}
      confirmLabel={COPY.confirm}
      action={COPY.action}
      onConfirm={confirm}
    >
      <RevokePasskeysSwitch
        label={COPY.revokePasskeys} hint={COPY.revokePasskeysHint} checked={revokePasskeys} onChange={setRevokePasskeys}
      />
    </ConfirmDialog>
  );
}
