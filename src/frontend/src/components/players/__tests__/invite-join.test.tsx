import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import RegisterPage from "../../../pages/Register";
import VerifyEmailPage from "../../../pages/VerifyEmail";
import { renderPage, signOut, stubFetch } from "../../../test/harness";
import { INVITES_COPY } from "../../../lib/playersCopy";
import { savePendingInvite } from "../../../lib/playersPending";
import { REGISTER, VERIFY_OK_HEADING } from "../../../lib/registrationCopy";

/**
 * R1 F2.3 — a friend who arrives by an invite link and joins the club is told, at each step of the
 * way in, that the invite is kept for after approval.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

describe("joining the club with an invite waiting", () => {
  it("the join form says the invite is kept", async () => {
    savePendingInvite("tok", null);
    stubFetch([]);
    renderPage(<RegisterPage />, { initialEntries: ["/register"] });
    expect(await screen.findByRole("heading", { name: REGISTER.title })).toBeInTheDocument();
    expect(screen.getByText(INVITES_COPY.pendingNote)).toBeInTheDocument();
  });

  it("says nothing of invites to somebody who came without one", async () => {
    stubFetch([]);
    renderPage(<RegisterPage />, { initialEntries: ["/register"] });
    expect(await screen.findByRole("heading", { name: REGISTER.title })).toBeInTheDocument();
    expect(screen.queryByText(INVITES_COPY.pendingNote)).toBeNull();
  });

  it("the confirmed email says it waits for the first sign-in after approval", async () => {
    savePendingInvite("tok", null);
    stubFetch([{ method: "POST", path: "/api/v1/auth/verify-email", body: { verified: true } }]);
    renderPage(<Routes><Route path="/verify-email/:token" element={<VerifyEmailPage />} /></Routes>, {
      initialEntries: ["/verify-email/abc"],
    });
    expect(await screen.findByText(VERIFY_OK_HEADING)).toBeInTheDocument();
    expect(screen.getByText(INVITES_COPY.pendingNoteVerified)).toBeInTheDocument();
  });

  it("a member's own unanswered link is not shown to a stranger joining on the same device", async () => {
    savePendingInvite("tok", "u-somebody");
    stubFetch([]);
    renderPage(<RegisterPage />, { initialEntries: ["/register"] });
    expect(await screen.findByRole("heading", { name: REGISTER.title })).toBeInTheDocument();
    expect(screen.queryByText(INVITES_COPY.pendingNote)).toBeNull();
  });
});
