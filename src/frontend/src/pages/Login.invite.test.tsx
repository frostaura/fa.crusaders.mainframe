import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import LoginPage from "./Login";
import { RequireAuth } from "../App";
import { LOGIN } from "../lib/authCopy";
import { savePendingInvite } from "../lib/playersPending";
import { renderPage, signOut, stubFetch } from "../test/harness";

/**
 * R1, for lane F2's invite journey (their pages, this lane's router and sign-in):
 * an invite link opens signed out (its page shows the preview and "Sign in to answer"); signing
 * in from one says what the sign-in is for; and a first sign-in with no page asked for goes to
 * the invite this device is still waiting to answer rather than to the landing.
 */
const MEMBER = "77777777-7777-7777-7777-777777777777";

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function routes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/from-wallet" element={<Navigate to="/login" replace state={{ from: { pathname: "/wallet" } }} />} />
      <Route path="/from-invite" element={<Navigate to="/login" replace state={{ from: { pathname: "/j/tok-1" } }} />} />
      <Route path="/j/:token" element={<RequireAuth allowAnonymous><Where /></RequireAuth>} />
      <Route path="/wallet" element={<RequireAuth><Where /></RequireAuth>} />
      <Route path="/my-code" element={<Where />} />
    </Routes>
  );
}

function signInWith(entry: string) {
  stubFetch([
    { method: "POST", path: "/api/v1/auth/login", body: { access_token: "t", user_id: MEMBER, is_admin: false } },
    { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
  ]);
  renderPage(routes(), { initialEntries: [entry] });
}

async function submit() {
  fireEvent.change(await screen.findByLabelText(LOGIN.email), { target: { value: "sam@club.test" } });
  fireEvent.change(screen.getByLabelText(LOGIN.password), { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: LOGIN.submit }));
}

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

describe("invites and signing in", () => {
  it("lets a signed-out visitor open an invite link", async () => {
    stubFetch([]);
    renderPage(routes(), { initialEntries: ["/j/tok-1"] });
    expect(await screen.findByTestId("where")).toHaveTextContent("/j/tok-1");
  });

  it("still sends a signed-out visitor from a page that needs a member to /login", async () => {
    stubFetch([]);
    renderPage(routes(), { initialEntries: ["/wallet"] });
    expect(await screen.findByLabelText(LOGIN.email)).toBeInTheDocument();
  });

  it("says what signing in is for when it came from an invite, and goes back to it", async () => {
    signInWith("/from-invite");
    expect(await screen.findByText(LOGIN.inviteNotice)).toBeInTheDocument();
    await submit();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/j/tok-1"));
  });

  it("takes a first sign-in with no page asked for to the invite this device is waiting on", async () => {
    savePendingInvite("tok-9", null);
    signInWith("/login");
    expect(screen.queryByText(LOGIN.inviteNotice)).toBeNull();
    await submit();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/j/tok-9"));
  });

  it("keeps the page the member asked for over a waiting invite (the fixture, varied)", async () => {
    savePendingInvite("tok-9", null);
    signInWith("/from-wallet");
    await submit();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/wallet"));
  });
});
