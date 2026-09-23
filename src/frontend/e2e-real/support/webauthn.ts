import type { CDPSession, Page } from "@playwright/test";

/**
 * A virtual passkey authenticator for the page, through Chromium's DevTools protocol.
 *
 * <p>
 * The passkey flows call `navigator.credentials.create/get`, which in a real browser opens an OS
 * sheet no automation can press. A virtual platform authenticator with automatic presence and
 * verification answers those calls itself, so a spec can register a passkey and sign in with it.
 * Chromium only — the CDP domain does not exist elsewhere, and this suite only runs Chromium.
 * </p>
 */
export type VirtualAuthenticator = {
  id: string;
  cdp: CDPSession;
  /** Credentials the authenticator currently holds (count is enough for most assertions). */
  credentials: () => Promise<Array<{ credentialId: string; rpId?: string; userHandle?: string }>>;
  remove: () => Promise<void>;
};

export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    id: authenticatorId,
    cdp,
    credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials,
    remove: async () => {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      await cdp.send("WebAuthn.disable");
    },
  };
}
