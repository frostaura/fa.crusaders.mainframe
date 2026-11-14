import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./Login";
import RegisterPage from "./Register";
import { REGISTER_MESSAGES, REGISTER_UNSURE } from "@/lib/registrationCopy";
import { LOGIN_REFUSAL } from "@/lib/authCopy";
import { isPasskeyAlreadyHere, isPasskeyCancel, registerPasskey } from "@/lib/webauthn";
import { renderPage, signIn, signOut, stubFetch, type StubRoute } from "@/test/harness";

/**
 * Go-live member pass, lane frontend-member.
 * - FM-1: a transient 5xx on Register keeps the submit button (only a club that does not resolve hides it).
 * - FM-4: the photo is uploaded once across retries; an unanswered application says it may have
 *   arrived, and a resend lands (BP-14 answers every well-formed application alike). A photo the
 *   API refuses (BP-06) is uploaded afresh on the next try.
 * - FM-2: dismissing the browser's passkey sheet (NotAllowedError / AbortError) is not a failure.
 */
vi.setConfig({ testTimeout: 15_000 });
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "credentials");
  signOut();
});

const SUBMIT = /Submit application/i;

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@club.review.test" } });
  fireEvent.change(screen.getByLabelText("Membership number"), { target: { value: "MEM-1001" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Password123!" } });
  fireEvent.change(screen.getByLabelText("Photo of yourself"), { target: { files: [new File(["x"], "me.png", { type: "image/png" })] } });
  await screen.findByText(/Photo ready/i);
  fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
}

function register(registerRoute: Omit<StubRoute, "path" | "method">) {
  const stub = stubFetch([
    { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/club/photos/x.jpg" } },
    { method: "POST", path: "/api/v1/auth/register", ...registerRoute },
  ]);
  renderPage(<RegisterPage />, { initialEntries: ["/register"] });
  return stub;
}

describe("Register after a failure (FM-1)", () => {
  it.each([500, 502, 503, 504])("keeps Submit after a %i — the sentence says to try again", async (status) => {
    register({ status, body: { error: "unavailable" } });
    await fillAndSubmit();
    expect(await screen.findByText(/try again/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SUBMIT })).toBeInTheDocument();
  });

  it.each(["tenant_not_found", "tenant_unresolved"])("hides Submit when the club's address resolves to no club (%s)", async (code) => {
    register({ status: 404, body: { error: code } });
    await fillAndSubmit();
    await waitFor(() => expect(screen.queryByRole("button", { name: SUBMIT })).toBeNull());
  });
});

describe("Register when the reply goes missing (FM-4)", () => {
  it("uploads the photo once across retries, says an unanswered application may have arrived, and a resend lands", async () => {
    // BP-14: every well-formed application is answered alike, so the resend after a lost reply is
    // the same 200 whether or not the first one arrived — and the mailbox says which it was.
    const stub = register({ status: [504, 200], sequence: [{}, { status: "pending_email_verification" }] });
    await fillAndSubmit();
    expect(await screen.findByText(new RegExp(REGISTER_UNSURE.mayHaveArrived.slice(0, 30)))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
    expect(await screen.findByText(/Check your inbox/i)).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path === "/api/v1/uploads/photo")).toHaveLength(1);
    expect(stub.calls.filter((c) => c.path === "/api/v1/auth/register")).toHaveLength(2);
  });

  it("an ANSWERED 500 is not 'may have arrived'", async () => {
    register({ status: 500, body: {} });
    await fillAndSubmit();
    await screen.findByText(/try again/i);
    expect(screen.queryByText(new RegExp(REGISTER_UNSURE.mayHaveArrived.slice(0, 30)))).toBeNull();
  });

  it.each(["photo_required", "photo_url_invalid", "photo_missing"])(
    "a refused photo (%s) lands on the photo, and the next try uploads it again", async (code) => {
      const stub = register({ status: [400, 200], sequence: [{ error: code }, { status: "pending_email_verification" }] });
      await fillAndSubmit();
      expect(await screen.findByText(REGISTER_MESSAGES[code])).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
      expect(await screen.findByText(/Check your inbox/i)).toBeInTheDocument();
      expect(stub.calls.filter((c) => c.path === "/api/v1/uploads/photo")).toHaveLength(2);
    });
});

function browserSheet(get: () => Promise<unknown>, create: () => Promise<unknown> = () => Promise.resolve(null)) {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  Object.defineProperty(navigator, "credentials", { configurable: true, value: { get: vi.fn(get), create: vi.fn(create) } });
}

describe("Dismissing the passkey sheet (FM-2)", () => {
  it.each(["NotAllowedError", "AbortError"])("a %s from the sheet says nothing at all", async (name) => {
    browserSheet(() => Promise.reject(new DOMException("dismissed", name)));
    stubFetch([{ method: "POST", path: "/api/v1/auth/webauthn/login/options", body: { flowId: "f1", options: { challenge: "AAAA", allowCredentials: [] } } }]);
    renderPage(<LoginPage />, { initialEntries: ["/login"] });
    fireEvent.click(await screen.findByRole("button", { name: /Sign in with a passkey/i }));
    await waitFor(() => expect(navigator.credentials.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(LOGIN_REFUSAL.passkeyFailed)).toBeNull();
    expect(screen.getByRole("button", { name: /Sign in with a passkey/i })).toBeEnabled();
  });

  it("a real refusal from the club still says so (the fixture differs only in where it fails)", async () => {
    browserSheet(() => Promise.reject(new DOMException("broken", "SecurityError")));
    stubFetch([{ method: "POST", path: "/api/v1/auth/webauthn/login/options", body: { flowId: "f1", options: { challenge: "AAAA", allowCredentials: [] } } }]);
    renderPage(<LoginPage />, { initialEntries: ["/login"] });
    fireEvent.click(await screen.findByRole("button", { name: /Sign in with a passkey/i }));
    expect(await screen.findByText(LOGIN_REFUSAL.passkeyFailed)).toBeInTheDocument();
  });

  it("enrolment: a dismissal is a cancel, and InvalidStateError is 'already on this device'", async () => {
    signIn({ isAdmin: false });
    stubFetch([{ method: "POST", path: "/api/v1/me/webauthn/register/options", body: { flowId: "f2", options: {
      challenge: "AAAA", user: { id: "AAAA", name: "ada", displayName: "Ada" }, rp: { name: "Club" }, pubKeyCredParams: [],
    } } }]);
    browserSheet(() => Promise.resolve(null), () => Promise.reject(new DOMException("x", "NotAllowedError")));
    const cancelled = await registerPasskey("Phone").catch((e: unknown) => e);
    expect(isPasskeyCancel(cancelled)).toBe(true);
    browserSheet(() => Promise.resolve(null), () => Promise.reject(new DOMException("x", "InvalidStateError")));
    const there = await registerPasskey("Phone").catch((e: unknown) => e);
    expect(isPasskeyAlreadyHere(there)).toBe(true);
    expect(isPasskeyCancel(there)).toBe(false);
  });
});
