import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import App from "../App";
import LoginPage from "./Login";
import RegisterPage from "./Register";
import ForgotPasswordPage from "./ForgotPassword";
import ResetPasswordPage from "./ResetPassword";
import ChangePasswordPage from "./ChangePassword";
import ProfilePage from "./Profile";
import { ToastProvider } from "../components/Toast";
import { AuthProvider } from "../lib/auth";
import { tokenStore } from "../lib/api";
import { BalanceProvider, useBalance } from "../lib/balance";
import { ProfileProvider, useProfile } from "../lib/profile";
import { signIn, signOut, stubFetch, type StubRoute } from "../test/harness";
import { CHANGE_PASSWORD, FIELD_REQUIRED, LOGIN, PASSWORD_TOGGLE, checkFields } from "../lib/authCopy";
import { PHOTO_PICKER, PHOTO_REQUIRED, REGISTER, REGISTER_MESSAGES } from "../lib/registrationCopy";

/**
 * The member-facing auth screens.
 *
 * <p>
 * Every case here is a sentence a member was shown that was untrue, missing, or the same as the
 * sentence for a completely different problem — a password complaint for a blank name, an
 * "isn't approved yet" for an approved member, "Try again" for something that could never
 * succeed. The API now carries a stable snake_case code on each refusal; these hold the mapping,
 * because a code with no mapping is exactly as useless to a member as no code at all.
 * </p>
 *
 * <p>
 * `fireEvent`, never `user-event`: it hangs under this jsdom setup.
 * </p>
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

/** Reports where the router ended up, so a navigation is assertable rather than inferred. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>;
}

/** A router that can carry initial history state — which is how `RequireAuth` hands over a deep link. */
function renderAt(ui: ReactElement, entries: Parameters<typeof MemoryRouter>[0]["initialEntries"] = ["/"]) {
  return render(
    <MemoryRouter initialEntries={entries}>
      <AuthProvider>
        <ProfileProvider>
          <ToastProvider>
            {ui}
            <LocationProbe />
          </ToastProvider>
        </ProfileProvider>
      </AuthProvider>
    </MemoryRouter>,
    // StrictMode's mount → cleanup → mount has produced real defects on these screens (the
    // single-use links were spent twice); every screen here is rendered under it.
    { reactStrictMode: true },
  );
}

const err = (path: string, status: number, body: unknown, method = "POST"): StubRoute =>
  ({ method, path, status, body });

async function signInAs(emailValue: string, passwordValue: string) {
  fireEvent.change(screen.getByLabelText(LOGIN.email), { target: { value: emailValue } });
  fireEvent.change(screen.getByLabelText(LOGIN.password), { target: { value: passwordValue } });
  fireEvent.click(screen.getByRole("button", { name: LOGIN.submit }));
}

describe("Login — a 403 is two different problems", () => {
  it("names an unconfirmed email address and offers to send the link again", async () => {
    const stub = stubFetch([
      err("/api/v1/auth/login", 403, { error: "email_not_verified" }),
      { method: "POST", path: "/api/v1/auth/resend-verification", body: { ok: true } },
    ]);
    renderAt(<LoginPage />);
    await signInAs("unverified@club.test", "Password123!");

    expect(await screen.findByText(/haven't confirmed your email address/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the club to approve/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Resend the confirmation email/i }));
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/auth/resend-verification")).toBe(true));
    expect(stub.calls.at(-1)?.body).toEqual({ email: "unverified@club.test" });
    // Neutral on purpose — the endpoint answers the same for an address it has never seen.
    expect(await screen.findByText(/If that address is registered/i)).toBeInTheDocument();
  });

  it("keeps the not-approved message for a membership that really is pending", async () => {
    stubFetch([err("/api/v1/auth/login", 403, { error: "not_approved", status: "Pending" })]);
    renderAt(<LoginPage />);
    await signInAs("pending@club.test", "Password123!");

    expect(await screen.findByText(/waiting for the club to approve/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resend the confirmation email/i })).not.toBeInTheDocument();
  });

  it("names a suspension instead of telling a suspended member to wait for a review", async () => {
    // Both halves of "Your account isn't approved yet. An admin will email you once they've
    // reviewed it." were false here: the member HAD been approved, and the club had already
    // emailed them the reason for the suspension. The status is on the refusal; use it.
    stubFetch([err("/api/v1/auth/login", 403, { error: "not_approved", status: "Suspended" })]);
    renderAt(<LoginPage />);
    await signInAs("suspended@club.test", "Password123!");

    expect(await screen.findByText(/membership is suspended/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the club to approve/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resend the confirmation email/i })).not.toBeInTheDocument();
  });

  it("tells a rejected applicant the review already happened, and offers them no repair that cannot help", async () => {
    stubFetch([err("/api/v1/auth/login", 403, { error: "not_approved", status: "Rejected" })]);
    renderAt(<LoginPage />);
    await signInAs("rejected@club.test", "Password123!");

    expect(await screen.findByText(/wasn't approved/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the club to approve/i)).not.toBeInTheDocument();
    /*
      And it does not assert an email that this screen cannot know was sent.

      Reviewer D filed the same sentence on the SUSPENDED refusal: "The club emailed you the
      reason" is a claim about something that happened elsewhere, and a member who never got
      one — wrong address, spam folder, an admin who suspended an account and wrote nothing —
      is told the club has already explained itself and reads the silence as being ignored.
      The rejected refusal carried the identical sentence. What this screen actually knows is
      on the 403 in front of it: the review happened, the answer was no, and here is the club's
      own number and address, which the lines below assert are rendered as things to press.
    */
    expect(screen.queryByText(/The club emailed you/i), "asserts an email it cannot know was sent")
      .not.toBeInTheDocument();
    // Confirming an address cannot un-reject an application, and the walk ends at a screen
    // saying an admin will review it — which is what had already happened.
    expect(screen.queryByRole("button", { name: /Resend the confirmation email/i })).not.toBeInTheDocument();
  });

  it("renders 'Forgot password?' as something clickable rather than as a caption", () => {
    stubFetch([]);
    renderAt(<LoginPage />);

    const forgot = screen.getByRole("link", { name: "Forgot password?" });
    // It was the body-text slate with no underline, beside an accent-blue "Register" — so the
    // one control that helps a member who cannot get in was the one that did not look like one.
    expect(forgot.className).toContain("text-accent-strong");
    expect(forgot.className).toMatch(/(^|\s)underline(\s|$)/);
    expect(forgot.className).not.toContain("text-text-secondary");
    expect(forgot).toHaveAttribute("href", "/forgot-password");
    // R10 — "Register" navigates, so it is a link, never a button dressed as one.
    expect(screen.getByRole("link", { name: LOGIN.register })).toHaveAttribute("href", "/register");
    expect(screen.queryByRole("button", { name: LOGIN.register })).not.toBeInTheDocument();
  });

  it("says to wait rather than 'sign in failed' when the rate limiter answers", async () => {
    stubFetch([err("/api/v1/auth/login", 429, { error: "too_many_requests" })]);
    renderAt(<LoginPage />);
    await signInAs("someone@club.test", "Password123!");

    expect(await screen.findByText(/Too many sign-in attempts/i)).toBeInTheDocument();
  });

  // --- D8: "speak to them", on a screen that gave them no way to -------------------------

  /**
   * All three not-approved sentences end by telling the member to talk to the club, and
   * the sign-in screen is exactly where a member has nothing else left to try — they are
   * stopped before any API that knows a club's phone number is reachable to them. The
   * refusal now carries the club's public contact; the screen renders it as things that
   * can be pressed.
   */
  it.each([
    ["Suspended", /membership is suspended/i],
    ["Rejected", /wasn't approved/i],
    ["Pending", /waiting for the club to approve/i],
  ])("gives a %s member a way to reach the club it just told them to speak to", async (status, sentence) => {
    stubFetch([err("/api/v1/auth/login", 403, {
      error: "not_approved",
      status,
      contact: { phone: "021 555 0134", email: "desk@club.test" },
    })]);
    renderAt(<LoginPage />);
    await signInAs("someone@club.test", "Password123!");

    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "021 555 0134" })).toHaveAttribute("href", "tel:0215550134");
    expect(screen.getByRole("link", { name: "desk@club.test" })).toHaveAttribute("href", "mailto:desk@club.test");
  });

  /**
   * The absent case, which is the ordinary one against an API that predates the field —
   * and the one where a page that renders anything at all is making a claim. Nothing,
   * never an empty link, never "Call the club on null".
   */
  it.each([
    ["no contact key at all", { error: "not_approved", status: "Suspended" }],
    ["both halves null", { error: "not_approved", status: "Suspended", contact: { phone: null, email: null } }],
    ["a contact that is not an object", { error: "not_approved", status: "Suspended", contact: "021 555 0134" }],
    ["blank strings", { error: "not_approved", status: "Suspended", contact: { phone: "  ", email: "" } }],
  ])("claims nothing when the refusal carried %s", async (_case, body) => {
    stubFetch([err("/api/v1/auth/login", 403, body)]);
    renderAt(<LoginPage />);
    await signInAs("suspended@club.test", "Password123!");

    await screen.findByText(/membership is suspended/i);
    expect(document.querySelectorAll('a[href^="tel:"]')).toHaveLength(0);
    expect(document.querySelectorAll('a[href^="mailto:"]')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/null|undefined/);
  });

  /** One half is enough, and the other must not be invented to keep it company. */
  it("renders only the half the club actually set", async () => {
    stubFetch([err("/api/v1/auth/login", 403, {
      error: "not_approved", status: "Rejected", contact: { phone: null, email: "desk@club.test" },
    })]);
    renderAt(<LoginPage />);
    await signInAs("rejected@club.test", "Password123!");

    await screen.findByText(/wasn't approved/i);
    expect(screen.getByRole("link", { name: "desk@club.test" })).toBeInTheDocument();
    expect(document.querySelectorAll('a[href^="tel:"]')).toHaveLength(0);
  });

  /**
   * Scoped to the one refusal that asks the member to make contact. A wrong password is
   * not an invitation to phone the club, and a screen that printed the number for every
   * failure would be handing it to whoever is guessing credentials.
   */
  it("shows nothing of the sort on a refusal that is not about the membership", async () => {
    stubFetch([err("/api/v1/auth/login", 401, {
      error: "invalid_credentials", contact: { phone: "021 555 0134", email: "desk@club.test" },
    })]);
    renderAt(<LoginPage />);
    await signInAs("someone@club.test", "wrong");

    await screen.findByText(/Email or password is incorrect/i);
    expect(document.querySelectorAll('a[href^="tel:"]')).toHaveLength(0);
  });

  /** It belongs to the answer the API just gave, not to this browser. */
  it("drops the contact on the next attempt", async () => {
    stubFetch([{
      method: "POST",
      path: "/api/v1/auth/login",
      status: 403,
      // `body` as well as `sequence`: the stub rejects outright for a route with neither
      // a `body` key nor a `respond`, and the rejection arrives at the page as a network
      // failure — so the screen shows "Couldn't reach the club" and the test fails for a
      // reason that has nothing to do with what it is about.
      body: null,
      // The same refusal twice, and the club has cleared its number between them. The
      // first answer must not still be on screen behind the second.
      sequence: [
        { error: "not_approved", status: "Suspended", contact: { phone: "021 555 0134", email: null } },
        { error: "not_approved", status: "Suspended" },
      ],
    }]);
    renderAt(<LoginPage />);
    await signInAs("suspended@club.test", "Password123!");
    expect(await screen.findByRole("link", { name: "021 555 0134" })).toBeInTheDocument();

    await signInAs("suspended@club.test", "Password123!");
    await waitFor(() => expect(document.querySelectorAll('a[href^="tel:"]')).toHaveLength(0));
    expect(screen.getByText(/membership is suspended/i)).toBeInTheDocument();
  });
});

describe("Login — the page you actually asked for", () => {
  it("returns to the deep link RequireAuth captured, not the default landing", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t", user_id: "u1", is_admin: false } },
    ]);
    // Exactly the shape `RequireAuth` hands over: `state.from` is a router location.
    renderAt(<LoginPage />, [{ pathname: "/login", state: { from: { pathname: "/wallet", search: "" } } }]);
    await signInAs("member@club.test", "Password123!");

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/wallet"));
  });

  it("refuses an off-site 'from' rather than bouncing the member out of the app", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t", user_id: "u1", is_admin: false } },
    ]);
    renderAt(<LoginPage />, [{ pathname: "/login", state: { from: { pathname: "//evil.example.com" } } }]);
    await signInAs("member@club.test", "Password123!");

    // R15 — the default landing moved from /schedule to /my-code.
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/my-code"));
  });
});

describe("Login — the form itself", () => {
  it("says what is missing on each field without asking the server", () => {
    const stub = stubFetch([]);
    renderAt(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: LOGIN.submit }));

    const email = screen.getByLabelText(LOGIN.email);
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(FIELD_REQUIRED.email)).toBeInTheDocument();
    expect(screen.getByText(FIELD_REQUIRED.password)).toBeInTheDocument();
    expect(document.activeElement).toBe(email);
    expect(stub.calls).toHaveLength(0);
  });

  it("works while it signs in instead of freezing the button", async () => {
    // The API never answers, so the button can be looked at while it works.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderAt(<LoginPage />);
    await signInAs("member@club.test", "Password123!");

    const button = screen.getByRole("button", { name: LOGIN.submit });
    // R12 — `aria-busy` with a spinner, never `disabled`: focus stays, a second press is ignored.
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).not.toBeDisabled();
  });

  it("shows and hides the password from a named control inside the field", () => {
    stubFetch([]);
    renderAt(<LoginPage />);
    const password = screen.getByLabelText(LOGIN.password);
    expect(password).toHaveAttribute("type", "password");

    const reveal = screen.getByRole("button", { name: PASSWORD_TOGGLE.show });
    // 44px icon button, and a `button` so Enter in the field still submits the form.
    expect(reveal).toHaveAttribute("type", "button");
    fireEvent.click(reveal);
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: PASSWORD_TOGGLE.hide })).toBeInTheDocument();
  });

  describe("on a device with passkeys", () => {
    beforeEach(() => {
      vi.stubGlobal("PublicKeyCredential", class {});
      vi.stubGlobal("navigator", { ...navigator, credentials: { create: vi.fn(), get: vi.fn() } });
    });

    /** It was a bare 56px circle with an 11px caption, and the fastest way in read as decoration. */
    it("offers the passkey as a real, named control above the password form", () => {
      stubFetch([]);
      renderAt(<LoginPage />);
      const passkey = screen.getByRole("button", { name: LOGIN.passkey });
      const form = screen.getByRole("button", { name: LOGIN.submit }).closest("form")!;
      expect(passkey.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(passkey.className).toContain("w-full");
    });
  });
});

describe("Register — one message per mistake", () => {
  /**
   * `await`ed, because PhotoPicker prepares the photo when it is PICKED rather than when the
   * form is submitted — it decodes, downscales and re-encodes it, which is asynchronous. A
   * synchronous fill raced that work and submitted with no photo attached, which is the same
   * race a member hits by picking and immediately pressing submit; the screen guards it by
   * disabling the button while preparation runs.
   */
  const fill = async () => {
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@club.test" } });
    fireEvent.change(screen.getByLabelText("Membership number"), { target: { value: "MEM-1001" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Password123!" } });
    const file = new File(["x"], "me.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Photo of yourself"), { target: { files: [file] } });
    await screen.findByText(/Photo ready/i);
  };

  /**
   * <b>Clicked, not submitted on the form — and the change is the regression guard.</b>
   *
   * <p>
   * This used to dispatch `submit` on the form directly, with a note explaining that jsdom
   * leaves a `required` file input's `valueMissing` set even once a File has been assigned, so
   * a click is swallowed by constraint validation. That note was true, and it was describing
   * D4's bug 1 from the inside: a real Chrome does the same thing for the same reason, on an
   * `sr-only` input it cannot draw a bubble on, and the whole screen was therefore inert. The
   * workaround made three tests pass over a form nobody could submit.
   * </p>
   *
   * <p>
   * Pressing the button is what a member does. If the `required` attribute ever comes back,
   * every test in this block goes red rather than quietly routing around it.
   * </p>
   */
  const submit = () => fireEvent.click(screen.getByRole("button", { name: /Submit application/i }));

  /**
   * The one commitment on the page, at rest.
   *
   * <p>
   * RETIRED by the design system (design-system.md, Icons — "No glyph on buttons at rest"; the
   * thumbs `ActionGlyph` and item 12's `affirm` intent are gone, D5/R8): this used to assert a
   * `data-intent="affirm"` glyph on the button. What is kept is the invariant under it — the
   * words are the accessible name — and the new rule is pinned instead: nothing drawn beside the
   * label until the button is working, and working is a spinner, not a frozen control.
   * </p>
   */
  it("sends the application from a plain, named button that shows progress rather than freezing", async () => {
    stubFetch([]);
    renderAt(<RegisterPage />);
    const button = await screen.findByRole("button", { name: REGISTER.submit });
    expect(button).not.toHaveAttribute("data-intent");
    expect(button.querySelector('[data-slot="button-label"] svg'), "a glyph at rest").toBeNull();

    await fill();
    // The API never answers, so the button can be looked at while it works.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    submit();
    // R12 — busy, not disabled: focus stays on it and a second press is ignored.
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).not.toBeDisabled();
    expect(button).toHaveAccessibleName(REGISTER.submit);
  });

  /**
   * D4 bug 1, at the unit level. The browser half of it — `required` on a 1x1 clipped input
   * making Chrome refuse to submit with no bubble and no console line — is guarded in
   * `e2e/register.spec.ts`; this is the half that says the form does its own checking and
   * says so on the field.
   */
  it("says why it will not send an application with no photo, on the field, once", async () => {
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/crusaders/photos/x.png" } },
      { method: "POST", path: "/api/v1/auth/register", body: { user_id: "u1", status: "pending_email_verification" } },
    ]);
    renderAt(<RegisterPage />);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@club.test" } });
    fireEvent.change(screen.getByLabelText("Membership number"), { target: { value: "MEM-1001" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Password123!" } });
    submit();

    // ONE live region, not two. The picker used to raise its message to the page's own `Alert`
    // as well as rendering it itself, and both carried role="alert". Now the form's summary is
    // the one that speaks (design-system.md: errors inline on the field + a summary), and the
    // sentence itself sits on the field — rewritten from "the alert IS the field message".
    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(checkFields(1));
    // Described by the message, so a screen reader hears it on the field and not only as it
    // arrives — and the keyboard is put there, because on a phone the field is off-screen.
    const field = screen.getByLabelText(PHOTO_PICKER.label);
    expect(field).toHaveAttribute("aria-invalid", "true");
    const message = screen.getByText(PHOTO_REQUIRED);
    expect(field.getAttribute("aria-describedby")).toContain(message.closest("p")!.id);
    expect(document.activeElement).toBe(field);
    // Nothing was sent: no photo upload, no registration.
    expect(stub.calls).toHaveLength(0);
  });

  /**
   * Every field says what is wrong with it, and the keyboard goes to the first. The browser's
   * own bubbles are off (`noValidate`) because they cannot be styled, do not survive a theme,
   * and say "Please fill out this field." about a membership number.
   */
  it("marks every empty field at once and takes the keyboard to the first", async () => {
    const stub = stubFetch([]);
    renderAt(<RegisterPage />);
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(checkFields(5));
    for (const label of [REGISTER.fullName, REGISTER.email, REGISTER.membershipNumber, REGISTER.password]) {
      expect(screen.getByLabelText(label)).toHaveAttribute("aria-invalid", "true");
    }
    expect(document.activeElement).toBe(screen.getByLabelText(REGISTER.fullName));
    expect(stub.calls).toHaveLength(0);

    // Typing into a field answers its complaint there and then.
    fireEvent.change(screen.getByLabelText(REGISTER.fullName), { target: { value: "Ada Lovelace" } });
    expect(screen.getByLabelText(REGISTER.fullName)).not.toHaveAttribute("aria-invalid");
  });

  /** A refusal that is about one field lands ON that field, not in a banner at the foot. */
  it("puts a taken email address on the Email field", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/crusaders/photos/x.png" } },
      err("/api/v1/auth/register", 409, { error: "email_in_use" }),
    ]);
    renderAt(<RegisterPage />);
    await fill();
    submit();

    const message = await screen.findByText(REGISTER_MESSAGES.email_in_use);
    const email = screen.getByLabelText(REGISTER.email);
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email.getAttribute("aria-describedby")).toContain(message.closest("p")!.id);
    expect(document.activeElement).toBe(email);
  });

  it("lets the applicant see the password they typed", async () => {
    stubFetch([]);
    renderAt(<RegisterPage />);
    const password = screen.getByLabelText(REGISTER.password);
    expect(password).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: PASSWORD_TOGGLE.show }));
    expect(password).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: PASSWORD_TOGGLE.hide }));
    expect(password).toHaveAttribute("type", "password");
  });

  /**
   * The mutant this kills: re-adding `required` to the file input. jsdom enforces constraint
   * validation on a click exactly as Chrome does, so the assertion above would go red — and
   * this one states the rule directly, because the attribute is the defect.
   */
  it("never puts the browser's own constraint validation on the hidden file input", async () => {
    stubFetch([]);
    renderAt(<RegisterPage />);
    const field = screen.getByLabelText("Photo of yourself") as HTMLInputElement;
    expect(field.required).toBe(false);
    expect(field).toHaveAttribute("aria-required", "true");
  });

  it("clears the photo complaint the moment a photo is chosen", async () => {
    stubFetch([]);
    renderAt(<RegisterPage />);
    // The four text fields carry the browser's own `required`, which is correct for a VISIBLE
    // control — it has somewhere to draw its bubble. They have to be filled or the submit never
    // reaches the handler, which is the point being made about the file input next door.
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@club.test" } });
    fireEvent.change(screen.getByLabelText("Membership number"), { target: { value: "MEM-1001" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Password123!" } });
    submit();
    await screen.findByText(/add a photo of yourself/i);

    fireEvent.change(screen.getByLabelText("Photo of yourself"), {
      target: { files: [new File(["x"], "me.png", { type: "image/png" })] },
    });
    await screen.findByText(/Photo ready/i);
    expect(screen.queryByText(/add a photo of yourself/i)).not.toBeInTheDocument();
  });

  it("tells an applicant how long approval takes, on the screen they land on", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/crusaders/photos/x.png" } },
      { method: "POST", path: "/api/v1/auth/register", body: { user_id: "u1", status: "pending_email_verification" } },
    ]);
    renderAt(<RegisterPage />);
    await fill();
    submit();

    expect(await screen.findByText(/Check your inbox/i)).toBeInTheDocument();
    expect(screen.getByText(/day or two/i)).toBeInTheDocument();
  });

  it("names a taken membership number instead of telling the applicant to try again", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/crusaders/photos/x.png" } },
      err("/api/v1/auth/register", 409, { error: "membership_number_in_use" }),
    ]);
    renderAt(<RegisterPage />);
    await fill();
    submit();

    expect(await screen.findByText(/membership number is already registered/i)).toBeInTheDocument();
    expect(screen.queryByText(/Try again\./i)).not.toBeInTheDocument();
  });

  it("does not blame the password for a missing field", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/crusaders/photos/x.png" } },
      err("/api/v1/auth/register", 400, { error: "missing_fields" }),
    ]);
    renderAt(<RegisterPage />);
    await fill();
    submit();

    expect(await screen.findByText(/fill in every field/i)).toBeInTheDocument();
    // The password hint under the field says "At least 8 characters." whatever happens; what
    // must not appear is the password *complaint*, which is what every 400 used to produce.
    expect(screen.queryByText(/^Your password must be at least 8 characters/i)).not.toBeInTheDocument();
  });

  it("still names a short password when that is what was wrong", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/uploads/photo", body: { url: "/uploads/crusaders/photos/x.png" } },
      err("/api/v1/auth/register", 400, { error: "password_too_short" }),
    ]);
    renderAt(<RegisterPage />);
    await fill();
    submit();

    expect(await screen.findByText(/password must be at least 8 characters/i)).toBeInTheDocument();
  });
});

describe("Forgot password", () => {
  it("sends the request and confirms without saying whether the address exists", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/auth/forgot-password", body: { ok: true } }]);
    renderAt(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "who@club.test" } });
    fireEvent.click(screen.getByRole("button", { name: /Send reset link/i }));

    await waitFor(() => expect(stub.calls[0]?.path).toBe("/api/v1/auth/forgot-password"));
    expect(stub.calls[0]?.body).toEqual({ email: "who@club.test" });
    expect(await screen.findByText(/belongs to an account/i)).toBeInTheDocument();
  });
});

/** The token comes from the path, so the page has to be mounted on its real route to see one. */
function renderResetPassword() {
  return render(
    <MemoryRouter initialEntries={["/reset-password/abc"]}>
      <AuthProvider><ToastProvider>
        <Routes><Route path="/reset-password/:token" element={<ResetPasswordPage />} /></Routes>
      </ToastProvider></AuthProvider>
    </MemoryRouter>,
  );
}

describe("Reset password", () => {
  it("tells the member the link is spent rather than showing a code", async () => {
    stubFetch([err("/api/v1/auth/reset-password", 400, { error: "invalid_or_expired" })]);
    renderResetPassword();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Password123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Set new password/i }));

    expect(await screen.findByText(/expired or has already been used/i)).toBeInTheDocument();
    expect(screen.queryByText(/invalid_or_expired/)).not.toBeInTheDocument();
  });

  it("catches a mistyped confirmation before it reaches the API", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/auth/reset-password", body: { reset: true } }]);
    renderResetPassword();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Password124!" } });
    fireEvent.click(screen.getByRole("button", { name: /Set new password/i }));

    expect(await screen.findByText(/don't match/i)).toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("Change password", () => {
  it("distinguishes a wrong current password from a network failure", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: { ...whoami, must_change_password: true } },
      err("/api/v1/me/password", 400, { error: "current_password_incorrect" }),
    ]);
    renderAt(<ChangePasswordPage />);

    // The forced framing, because whoami says a temporary password is in force.
    expect(await screen.findByLabelText("Temporary password")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "wrong" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Password123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Change password/i }));

    expect(await screen.findByText(/not your current password/i)).toBeInTheDocument();
    // On the field it is about, with the keyboard taken there to fix it.
    const temporary = screen.getByLabelText(CHANGE_PASSWORD.temporary);
    expect(temporary).toHaveAttribute("aria-invalid", "true");
    expect(document.activeElement).toBe(temporary);
  });

  it("refuses a 'new' password that is the old one, without asking the server", async () => {
    const whoami = signIn({ isAdmin: false });
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { method: "POST", path: "/api/v1/me/password", body: { changed: true } },
    ]);
    renderAt(<ChangePasswordPage />);

    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Password123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Change password/i }));

    // The field hint says the same thing, so match the error paragraph specifically.
    expect(await screen.findByText(/^Your new password has to be different/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path === "/api/v1/me/password")).toBe(false);
  });

  it("keeps the member signed in by adopting the token the change hands back", async () => {
    // The change ends every session minted before it, this one included; the answer carries its
    // replacement. Ignoring it signs the member out on their very next request.
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { method: "POST", path: "/api/v1/me/password", body: { changed: true, access_token: "fresh.session.token" } },
    ]);
    renderAt(<ChangePasswordPage />);

    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "Password123!" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Different456!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Different456!" } });
    fireEvent.click(screen.getByRole("button", { name: /Change password/i }));

    await waitFor(() => expect(tokenStore.get()).toBe("fresh.session.token"));
  });
});

describe("Profile — the name rule the server has always had", () => {
  const PROFILE = {
    user_id: "u1", email: "ada@club.test", is_admin: false, tenant_slug: "crusaders",
    full_name: "Ada Lovelace", membership_number: "MEM-1001", photo_url: null, status: "active",
  };

  it("states the minimum and refuses to offer Save for a name the API would reject", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);
    // R4 form factor: the name and password cards are on Profile's Account tab.
    renderAt(<ProfilePage />, ["/profile?tab=account"]);

    const field = await screen.findByLabelText("Full name");
    expect(screen.getByText(/At least 2 characters/i)).toBeInTheDocument();

    // F4.7 — refused by `aria-disabled`, not `disabled`: a button that disables itself under the
    // member's finger (a save makes the name "unchanged") drops focus on <body>.
    fireEvent.change(field, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");

    fireEvent.change(field, { target: { value: "x" } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");

    fireEvent.change(field, { target: { value: "Ada L" } });
    expect(screen.getByRole("button", { name: "Save" })).not.toHaveAttribute("aria-disabled");
  });

  it("offers somewhere to change the password at all", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
    ]);
    // R4 form factor: the name and password cards are on Profile's Account tab.
    renderAt(<ProfilePage />, ["/profile?tab=account"]);

    fireEvent.click(await screen.findByRole("button", { name: "Change password" }));
    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
  });
});

/**
 * The guard itself, driven through the real `<App />` router rather than a stand-in — the whole
 * point of both cases is what `RequireAuth` hands to `/login` and where it refuses to let a
 * session go, and a re-implementation in the test would prove nothing about either.
 */
describe("RequireAuth", () => {
  beforeEach(() => {
    // jsdom has no EventSource; BalanceProvider opens one as soon as a session exists.
    vi.stubGlobal("EventSource", class { close() {} addEventListener() {} } as unknown as typeof EventSource);
  });

  it("carries the page you asked for through the sign-in it forced on you", async () => {
    window.history.pushState({}, "", "/wallet");
    stubFetch([
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t", user_id: "u1", is_admin: false } },
      { path: "/api/v1/whoami", body: { ...signIn({ isAdmin: false }), user_id: "u1" } },
      { path: "/api/v1/me/profile", body: { user_id: "u1", email: "a@b.test", is_admin: false, tenant_slug: "crusaders", full_name: "Ada", membership_number: "M-1", photo_url: null, status: "active" } },
      { path: "/api/v1/wallet", body: { balance_minutes: 120, entries: [] } },
    ]);
    signOut(); // arrive genuinely signed out, the way a bookmarked link does

    render(<App />);
    await signInAs("member@club.test", "Password123!");

    await waitFor(() => expect(window.location.pathname).toBe("/wallet"));
  });

  it("takes a tab whose session was signed out in another tab back to /login, saying so", async () => {
    signIn({ isAdmin: false });
    window.history.pushState({}, "", "/wallet");
    stubFetch([
      { path: "/api/v1/whoami", body: { ...signIn({ isAdmin: false }), user_id: "u1" } },
      { path: "/api/v1/me/profile", body: { user_id: "u1", email: "a@b.test", is_admin: false, tenant_slug: "crusaders", full_name: "Ada", membership_number: "M-1", photo_url: null, status: "active" } },
      { path: "/api/v1/wallet", body: { balance_minutes: 300, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    ]);

    render(<App />);
    // Not the path — the path was already /wallet before the session was confirmed. This waits
    // for RequireAuth to have finished deciding, which is what makes the tab a signed-in one.
    //
    // Waited on by ROLE, not by the booting copy. It used to wait for the string "Loading…" to
    // disappear; when that screen became a spinner reading "Connecting to the club…", the wait
    // passed instantly against a tab that was still bootstrapping, the storage event then landed
    // while the status was still `loading` — which the listener deliberately ignores, because a
    // bootstrapping tab finds out for itself — and the test failed claiming the redirect was
    // broken when nothing was. A wait keyed on someone else's copy is a wait that stops waiting
    // the day the copy changes.
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(window.location.pathname).toBe("/wallet");

    // The other tab's sign-out, as this tab experiences it: the shared key disappears, and
    // `storage` fires in every tab BUT the one that did it.
    act(() => {
      localStorage.removeItem("crusaders.mainframe.token");
      window.dispatchEvent(new StorageEvent("storage", {
        key: "crusaders.mainframe.token", oldValue: "test.token.value", newValue: null,
      }));
    });

    // It used to keep the signed-in chrome and the last-rendered balance, offer a Top up
    // button, and answer every click with "Check your connection and press Refresh."
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(await screen.findByText(/Your session ended/i)).toBeInTheDocument();
  });

  it("holds a session carrying an admin-issued temporary password on the change screen", async () => {
    signIn({ isAdmin: false });
    window.history.pushState({}, "", "/schedule");
    stubFetch([
      { path: "/api/v1/whoami", body: { ...signIn({ isAdmin: false }), user_id: "u1", must_change_password: true } },
      { path: "/api/v1/me/profile", body: { user_id: "u1", email: "a@b.test", is_admin: false, tenant_slug: "crusaders", full_name: "Ada", membership_number: "M-1", photo_url: null, status: "active" } },
      { path: "/api/v1/wallet", body: { balance_minutes: 120, entries: [] } },
    ]);

    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/change-password"));
    expect(await screen.findByLabelText("Temporary password")).toBeInTheDocument();
  });
});

/**
 * What the header does across the forced change.
 *
 * <p>
 * The member finished the change, landed on /schedule, and sat there with a grey "?" where
 * their photo belongs and a dead "— cr" where their balance belongs, indefinitely — only a
 * manual page reload fixed it. Both providers keyed their effect on `auth.status`, which stays
 * "authenticated" throughout: only `mustChangePassword` moves, so nothing re-ran.
 * </p>
 *
 * <p>
 * Asserted as CALLS rather than as pixels, because the two states are told apart by what the
 * app asks the API for: nothing at all while the gate refuses it, and both reads the moment
 * the gate comes down.
 * </p>
 */
describe("the header across a forced password change", () => {
  const ADA = {
    user_id: "u1", email: "ada@club.test", is_admin: false, tenant_slug: "crusaders",
    full_name: "Ada Lovelace", membership_number: "MEM-1001", photo_url: null, status: "active",
  };

  function HeaderProbe() {
    const { profile } = useProfile();
    const { balance } = useBalance();
    return <span data-testid="header">{`${profile?.full_name ?? "?"}|${balance === null ? "— cr" : balance}`}</span>;
  }

  it("asks for the member's profile and balance the moment the gate comes down, with no reload", async () => {
    vi.stubGlobal("EventSource", class { close() {} addEventListener() {} } as unknown as typeof EventSource);
    signIn({ isAdmin: false });
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: { ...signIn({ isAdmin: false }), user_id: "u1", must_change_password: true } },
      { path: "/api/v1/me/profile", body: ADA },
      { path: "/api/v1/wallet", body: { balance_minutes: 300, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
      { method: "POST", path: "/api/v1/me/password", body: { changed: true } },
    ]);

    render(
      <MemoryRouter>
        <AuthProvider>
          <ProfileProvider>
            <BalanceProvider>
              <ToastProvider>
                <ChangePasswordPage />
                <HeaderProbe />
              </ToastProvider>
            </BalanceProvider>
          </ProfileProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    const asked = (path: string) => stub.calls.filter((c) => c.path.startsWith(path)).length;
    await screen.findByLabelText("Temporary password");
    // While the gate is armed the API refuses both with 403 password_change_required, so the
    // app does not ask — and the console does not fill with refusals the member cannot act on.
    expect(screen.getByTestId("header")).toHaveTextContent("?|— cr");
    expect(asked("/api/v1/me/profile")).toBe(0);
    expect(asked("/api/v1/wallet")).toBe(0);

    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "Temp-1234!" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "ChosenPass1!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "ChosenPass1!" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(screen.getByTestId("header")).toHaveTextContent("Ada Lovelace|300"));
    expect(asked("/api/v1/me/profile")).toBe(1);
  });
});

/**
 * L-F4 and N-F10 — an admin resets a member's password while that member is signed in.
 *
 * <p>
 * The server side is right: `PasswordChangeGate` refuses every route but the change itself
 * with `403 password_change_required`. The client only ever learned the flag from `whoami` at
 * boot, so an in-app route change afterwards rendered against a stale context and the 403s
 * landed in each screen's own `catch`. A finder clicked Reports and got
 * `TOP-UPS — · SPENT — · REFUNDS (NET) — · TIME ON COURT —`, a stale "−40.00 cr" still in the
 * header, a Download wallet CSV button still offered, and nothing in
 * `[role=status],[role=alert]` at any sample. A full page load did the right thing, which is
 * what made it look like a page bug rather than a context one.
 * </p>
 */
describe("an admin reset lands on a session that is already open", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", class {
      close() {}
      addEventListener() {}
      removeEventListener() {}
    } as unknown as typeof EventSource);
  });

  /** Signed in and un-gated at boot; every subsequent call refused, as the gate really does. */
  function afterTheReset(routes: StubRoute[] = []) {
    signIn({ isAdmin: false });
    const GATED = { status: 403, body: { error: "password_change_required", message: "Your password was reset by an admin. Choose a new one before continuing." } };
    return stubFetch([
      ...routes,
      // whoami is on the gate's allow-list, and at boot it had not been reset yet.
      { path: "/api/v1/whoami", body: { ...signIn({ isAdmin: false }), user_id: "u1" } },
      { path: "/api/v1/me/profile", ...GATED },
      { path: "/api/v1/wallet", ...GATED },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", ...GATED },
      { path: "/api/v1/reports/", ...GATED },
    ]);
  }

  it("routes the open session to the change-password screen instead of swallowing the refusal", async () => {
    window.history.pushState({}, "", "/wallet");
    afterTheReset();

    render(<App />);

    // Before: the member stayed on /wallet with a stale balance and no message of any kind.
    await waitFor(() => expect(window.location.pathname).toBe("/change-password"));
    expect(await screen.findByLabelText("Temporary password")).toBeInTheDocument();
    expect(screen.getByText(/Your account is on a temporary password/i)).toBeInTheDocument();
  });

  /**
   * The fixture, varied. A 403 that is NOT this gate — the admin surfaces answer one to a
   * member — must not throw them onto the change-password screen; that would be the same
   * defect wearing the fix's clothes.
   */
  it("does not treat every 403 as a password reset", async () => {
    window.history.pushState({}, "", "/wallet");
    signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: { ...signIn({ isAdmin: false }), user_id: "u1" } },
      { path: "/api/v1/me/profile", body: { user_id: "u1", email: "a@b.test", is_admin: false, tenant_slug: "crusaders", full_name: "Ada", membership_number: "M-1", photo_url: null, status: "active" } },
      { path: "/api/v1/wallet", status: 403, body: { error: "admin_only" } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    ]);

    render(<App />);

    // The wallet page's own heading (R11: every page has one h1 in its PageHeader) — "Wallet"
    // as bare text now also appears in its failure sentence and the chrome.
    await screen.findByRole("heading", { level: 1, name: "Wallet" });
    await new Promise((r) => setTimeout(r, 40));
    expect(window.location.pathname).toBe("/wallet");
  });
});

/**
 * N-F10 — what the forced screen may say about how the member got there.
 *
 * <p>
 * It said "An admin reset your password, so <b>the one you just used</b> is temporary", and
 * this screen has three arrivals of which only one used anything: a member who clicked the
 * welcome magic link typed no password at all, and a member reset mid-session (L-F4 above)
 * did not either. Both are then asked for a "Temporary password" they have to go and find in
 * another email, on a screen that never mentions the way out.
 * </p>
 */
describe("the forced change-password screen's copy", () => {
  function forced() {
    signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: { ...signIn({ isAdmin: false }), user_id: "u1", must_change_password: true } },
    ]);
    render(
      <MemoryRouter>
        <AuthProvider>
          <ToastProvider><ChangePasswordPage /></ToastProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  it("does not tell a member they just used a password they may never have seen", async () => {
    forced();
    await screen.findByLabelText("Temporary password");

    expect(screen.queryByText(/the one you just used/)).not.toBeInTheDocument();
    // True on all three arrivals: the temporary password EXISTS, whether or not it was used.
    expect(screen.getByText(/Your account is on a temporary password/i)).toBeInTheDocument();
    /*
     * And it must not claim an admin did it. The same principle as the line above, one case
     * further on: the club's FIRST admin reaches this screen because ProductionBootstrap
     * created their account from the compose file with must-change-password set. Nobody reset
     * anything — they are the admin. The screen cannot tell the two arrivals apart, so it may
     * only say what is true of both.
     */
    expect(screen.queryByText(/An admin has reset/i)).not.toBeInTheDocument();
    expect(screen.getByText(/stops working the moment you do/)).toBeInTheDocument();
  });

  it("offers a way through for a member who has not got the temporary password", async () => {
    forced();
    await screen.findByLabelText("Temporary password");

    // Before, the only exit was knowing that "Forgot password?" on the sign-in screen — a
    // screen this one does not link to and does not mention — would do it.
    const out = screen.getByRole("link", { name: /Email yourself a reset link/ });
    expect(out).toHaveAttribute("href", "/forgot-password");
  });
});
