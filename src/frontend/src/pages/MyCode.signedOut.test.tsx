import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import MyCodePage from "./MyCode";
import { RequireAuth } from "../App";
import { MEMBER_CODE_FIXTURE, renderPage, signOut, stubFetch } from "../test/harness";
import { fromHex, importHmacKey } from "../lib/memberCode/hotp";
import { saveMemberCode, wipeMemberCode } from "../lib/memberCode/keyStore";
import { forgetLastKnown } from "../lib/lastKnown";
import { MY_CODE } from "../lib/myCodeCopy";

/**
 * F4.1 — My Code after the session lapsed (the P7 decision: only an explicit sign-out wipes the
 * key). The member is signed out — no token, nothing the club will answer — and this device last
 * confirmed them; the key on the phone still makes their code, so the page shows it, says they
 * are signed out, and asks the club nothing. Rendered behind `RequireAuth`, as the app does — it
 * is what lets a signed-out device with a confirmed member through to this page at all.
 */
const MEMBER = "44444444-4444-4444-4444-444444444444";

async function codeOnScreen(): Promise<HTMLElement> {
  for (let i = 0; i < 500; i++) {
    const code = screen.queryByLabelText("Your code");
    if (code) return code;
    await act(async () => { await new Promise((r) => setImmediate(r)); });
  }
  throw new Error("the code never reached the pass");
}

describe("My Code — signed out after the session lapsed", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    forgetLastKnown();
    await wipeMemberCode();
    signOut();
    localStorage.clear();
  });

  it("shows the code from the key on this phone, says so, and asks the club nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MEMBER_CODE_FIXTURE.anchorMs));
    localStorage.setItem("crusaders.mainframe.last-identity", MEMBER);
    await saveMemberCode({
      key: await importHmacKey(fromHex(MEMBER_CODE_FIXTURE.secretHex)),
      ref: MEMBER_CODE_FIXTURE.ref, generation: 1, tz: MEMBER_CODE_FIXTURE.tz, offsetMs: 0, userId: MEMBER, enrolledAt: 0,
    });
    const stub = stubFetch([]);

    renderPage(<RequireAuth><MyCodePage /></RequireAuth>, { initialEntries: ["/my-code"] });

    expect(await codeOnScreen()).toHaveTextContent(MEMBER_CODE_FIXTURE.anchorToken);
    expect(screen.getByText(MY_CODE.signedOut.body)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: MY_CODE.signedOut.signIn })).toHaveAttribute("href", "/login");
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(stub.calls.map((c) => c.path), "no session, so nothing to ask with").toEqual([]);
  });

  it("asks the member to sign in when this phone holds no key", async () => {
    localStorage.setItem("crusaders.mainframe.last-identity", MEMBER);
    stubFetch([]);
    renderPage(<RequireAuth><MyCodePage /></RequireAuth>, { initialEntries: ["/my-code"] });
    expect(await screen.findByText(MY_CODE.signedOut.noKey)).toBeInTheDocument();
    expect(screen.queryByText(MY_CODE.signedOut.body)).toBeNull();
    expect(screen.queryByLabelText("Your code")).toBeNull();
  });

  it("never shows a key stored for somebody else", async () => {
    localStorage.setItem("crusaders.mainframe.last-identity", MEMBER);
    await saveMemberCode({
      key: await importHmacKey(fromHex(MEMBER_CODE_FIXTURE.secretHex)),
      ref: MEMBER_CODE_FIXTURE.ref, generation: 1, tz: MEMBER_CODE_FIXTURE.tz, offsetMs: 0, userId: "someone-else", enrolledAt: 0,
    });
    stubFetch([]);
    renderPage(<RequireAuth><MyCodePage /></RequireAuth>, { initialEntries: ["/my-code"] });
    expect(await screen.findByText(MY_CODE.signedOut.noKey)).toBeInTheDocument();
    expect(screen.queryByLabelText("Your code")).toBeNull();
  });
});
