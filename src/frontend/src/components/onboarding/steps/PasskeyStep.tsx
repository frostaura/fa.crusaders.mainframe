import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Key } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { TextLink } from "@/components/ui/text-link";
import { endpoints } from "@/lib/api";
import { GET_STARTED } from "@/lib/onboardingCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { isPasskeySupported, registerPasskey } from "@/lib/webauthn";
import { passkeyLabelFor } from "./passkeyLabel";
import { StepFrame } from "./StepFrame";

const COPY = GET_STARTED.steps.passkey;

/** How many passkeys the account has, or null when the read failed. */
function readPasskeyCount(): Promise<number | null> {
  return endpoints.webauthnList().then((rows) => (Array.isArray(rows) ? rows.length : null), () => null);
}

/** `undefined` while reading, `null` when the read failed, else how many passkeys exist. */
function usePasskeyCount(supported: boolean) {
  const [count, setCount] = useState<number | null | undefined>(supported ? undefined : null);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    readPasskeyCount().then((n) => { if (live) setCount(n); });
    return () => { live = false; };
  }, [supported]);
  const load = useCallback(() => readPasskeyCount().then(setCount), []);
  return { count, load };
}

/**
 * Passkey — the phone's own biometrics, through `lib/webauthn.ts`'s registration.
 *
 * <p>
 * A biometric surface, so no watermark (design-system § watermark, "Never"). A cancelled
 * browser sheet is not a failure and says nothing; a real failure is a toast that says nothing
 * was saved. A failed read of the existing passkeys only costs the "you already have one" line
 * — the Add button still works.
 * </p>
 */
export function PasskeyStep({ focusOnMount }: { focusOnMount?: boolean }) {
  const supported = isPasskeySupported();
  const { count, load } = usePasskeyCount(supported);
  const [added, setAdded] = useState(false);
  const add = useAsyncAction(async () => {
    try {
      await registerPasskey(passkeyLabelFor(navigator.userAgent));
    } catch (error) {
      if (error instanceof Error && error.message === "passkey_cancelled") return false;
      throw error;
    }
    return true;
  }, {
    success: (made) => {
      if (!made) return;
      setAdded(true);
      void load();
    },
    toast: { failure: COPY.failed },
  });

  return (
    <StepFrame icon={Key} title={COPY.title} body={COPY.body} focusOnMount={focusOnMount}>
      {supported ? (
        <PasskeyStatus count={count} added={added} />
      ) : (
        <p className="text-sm text-text-secondary">{COPY.unsupported}</p>
      )}
      {supported ? (
        <Button
          size="lg"
          variant={added || (count ?? 0) > 0 ? "secondary" : "primary"}
          className="self-start"
          onClick={() => void add.run()}
          pending={add.pending}
          icon={<Key aria-hidden="true" />}
        >
          {COPY.add}
        </Button>
      ) : null}
      <TextLink variant="standalone" to="/profile" className="self-start">{COPY.manage}</TextLink>
    </StepFrame>
  );
}

function PasskeyStatus({ count, added }: { count: number | null | undefined; added: boolean }) {
  if (added) {
    return <p role="status" className="text-sm font-semibold text-success-strong">{COPY.added}</p>;
  }
  if (count === undefined) {
    return <div><Skeleton className="h-5 w-48" /><span className="sr-only">{COPY.checking}</span></div>;
  }
  if (count !== null && count > 0) {
    return <p className="text-sm font-semibold text-text-primary">{COPY.already(count)}</p>;
  }
  return null;
}
