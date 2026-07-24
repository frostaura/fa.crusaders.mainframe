/**
 * WebAuthn browser helpers.
 *
 * Fido2NetLib serialises challenges and credential ids as base64url strings; the browser
 * `navigator.credentials.*` APIs need ArrayBuffers. These helpers translate between the two
 * and shape the response back into the JSON the server expects.
 */

import { endpoints, type LoginResponse } from "./api";

export const isPasskeySupported = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.PublicKeyCredential !== "undefined" &&
  typeof navigator.credentials?.create === "function" &&
  typeof navigator.credentials?.get === "function";

/* ---------- base64url ⇄ ArrayBuffer ---------- */

const b64uToBuf = (s: string): ArrayBuffer => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Slice off the underlying buffer so we return a plain ArrayBuffer (the WebAuthn DOM types
  // are stricter than `BufferSource` in current TS lib versions and disallow shared variants).
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
};

const bytesToB64u = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/* ---------- coercion: Fido2NetLib options -> browser CredentialOptions ---------- */

type AnyOpts = Record<string, unknown>;

function coerceCreateOptions(opts: AnyOpts): PublicKeyCredentialCreationOptions {
  const o = opts as AnyOpts;
  return {
    rp: o.rp as PublicKeyCredentialRpEntity,
    user: {
      id: b64uToBuf(((o.user as AnyOpts).id as string)),
      name: (o.user as AnyOpts).name as string,
      displayName: (o.user as AnyOpts).displayName as string,
    },
    challenge: b64uToBuf(o.challenge as string),
    pubKeyCredParams: o.pubKeyCredParams as PublicKeyCredentialParameters[],
    timeout: o.timeout as number | undefined,
    excludeCredentials: ((o.excludeCredentials as AnyOpts[] | undefined) ?? []).map((c) => ({
      id: b64uToBuf(c.id as string),
      type: "public-key",
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    authenticatorSelection: o.authenticatorSelection as AuthenticatorSelectionCriteria | undefined,
    attestation: o.attestation as AttestationConveyancePreference | undefined,
    extensions: o.extensions as AuthenticationExtensionsClientInputs | undefined,
  };
}

function coerceRequestOptions(opts: AnyOpts): PublicKeyCredentialRequestOptions {
  const o = opts as AnyOpts;
  return {
    challenge: b64uToBuf(o.challenge as string),
    timeout: o.timeout as number | undefined,
    rpId: o.rpId as string | undefined,
    allowCredentials: ((o.allowCredentials as AnyOpts[] | undefined) ?? []).map((c) => ({
      id: b64uToBuf(c.id as string),
      type: "public-key",
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    userVerification: o.userVerification as UserVerificationRequirement | undefined,
    extensions: o.extensions as AuthenticationExtensionsClientInputs | undefined,
  };
}

/* ---------- browser response -> Fido2NetLib raw response ---------- */

function attestationToRaw(c: PublicKeyCredential) {
  const att = c.response as AuthenticatorAttestationResponse;
  return {
    id: c.id,
    rawId: bytesToB64u(c.rawId),
    type: c.type,
    response: {
      attestationObject: bytesToB64u(att.attestationObject),
      clientDataJSON: bytesToB64u(att.clientDataJSON),
    },
    extensions: c.getClientExtensionResults(),
  };
}

function assertionToRaw(c: PublicKeyCredential) {
  const att = c.response as AuthenticatorAssertionResponse;
  return {
    id: c.id,
    rawId: bytesToB64u(c.rawId),
    type: c.type,
    response: {
      authenticatorData: bytesToB64u(att.authenticatorData),
      clientDataJSON: bytesToB64u(att.clientDataJSON),
      signature: bytesToB64u(att.signature),
      userHandle: att.userHandle ? bytesToB64u(att.userHandle) : null,
    },
    extensions: c.getClientExtensionResults(),
  };
}

/* ---------- public flows ---------- */

/** End-to-end passkey login. Returns the same shape as `endpoints.login`. */
export async function loginWithPasskey(): Promise<LoginResponse> {
  if (!isPasskeySupported()) throw new Error("passkey_unsupported");
  const { flowId, options } = await endpoints.webauthnLoginOptions();
  const credentialOptions = coerceRequestOptions(options as AnyOpts);
  const credential = (await navigator.credentials.get({ publicKey: credentialOptions })) as PublicKeyCredential | null;
  if (!credential) throw new Error("passkey_cancelled");
  return endpoints.webauthnLogin(flowId, assertionToRaw(credential));
}

/** End-to-end passkey enrolment for the signed-in user. Returns the new credential id + label. */
export async function registerPasskey(label: string): Promise<{ id: string; label: string }> {
  if (!isPasskeySupported()) throw new Error("passkey_unsupported");
  const { flowId, options } = await endpoints.webauthnRegisterOptions(label);
  const credentialOptions = coerceCreateOptions(options as AnyOpts);
  const credential = (await navigator.credentials.create({ publicKey: credentialOptions })) as PublicKeyCredential | null;
  if (!credential) throw new Error("passkey_cancelled");
  const att = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof att.getTransports === "function" ? att.getTransports() : null;
  return endpoints.webauthnRegister(flowId, attestationToRaw(credential), transports);
}
