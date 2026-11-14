import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import VerifyEmailPage from "./VerifyEmail";
import { signOut, stubFetch } from "../test/harness";
import { VERIFY_OK_BODY, VERIFY_OK_BODY_APPROVED, VERIFY_OK_BODY_UNKNOWN, VERIFY_OK_HEADING } from "../lib/registrationCopy";

/**
 * Go-live BM-11 — an admin approved Bob before he confirmed his address, and the confirmation page
 * told him to wait for an approval that had already happened. It now says what the API says.
 */
afterEach(() => { vi.unstubAllGlobals(); signOut(); });

function open(body: object) {
  stubFetch([{ method: "POST", path: "/api/v1/auth/verify-email/", body }]);
  render(
    <MemoryRouter initialEntries={["/verify-email/tok"]}>
      <Routes><Route path="/verify-email/:token" element={<VerifyEmailPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe("the email-confirmed page (BM-11)", () => {
  it("an account the club already approved is told to sign in, not to wait", async () => {
    open({ verified: true, approved: true });
    expect(await screen.findByRole("heading", { name: VERIFY_OK_HEADING })).toBeInTheDocument();
    expect(screen.getByText(VERIFY_OK_BODY_APPROVED)).toBeInTheDocument();
    expect(screen.queryByText(/you'll get a second email/)).toBeNull();
  });

  it("one still waiting is told about the check and the second email", async () => {
    open({ verified: true, approved: false });
    expect(await screen.findByText(VERIFY_OK_BODY)).toBeInTheDocument();
  });

  it("an API that does not say claims neither", async () => {
    open({ verified: true });
    expect(await screen.findByText(VERIFY_OK_BODY_UNKNOWN)).toBeInTheDocument();
    expect(screen.queryByText(VERIFY_OK_BODY_APPROVED)).toBeNull();
  });
});
