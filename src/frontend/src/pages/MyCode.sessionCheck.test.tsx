import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import MyCodePage from "./MyCode";
import { RequireAuth } from "../App";
import { MEMBER_CODE_FIXTURE, renderPage, signOut } from "../test/harness";
import { tokenStore } from "../lib/api";
import { fromHex, importHmacKey } from "../lib/memberCode/hotp";
import { saveMemberCode, wipeMemberCode } from "../lib/memberCode/keyStore";
import { forgetLastKnown } from "../lib/lastKnown";

/**
 * P4-1 (review round 4) — My Code waited for `whoami`. At a court with one bar of signal the
 * session check took up to 20 s and the member stood at the door looking at the boot splash,
 * while the code they needed was on the phone all along. With a token and a member this device has
 * confirmed, the code is painted from the phone's key while the check is still out.
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

describe("My Code while the session check is out", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    forgetLastKnown();
    await wipeMemberCode();
    signOut();
    localStorage.clear();
  });

  it("shows the code from the phone's key without waiting for the club", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MEMBER_CODE_FIXTURE.anchorMs));
    tokenStore.set("member.jwt.value");
    localStorage.setItem("crusaders.mainframe.last-identity", MEMBER);
    await saveMemberCode({
      key: await importHmacKey(fromHex(MEMBER_CODE_FIXTURE.secretHex)),
      ref: MEMBER_CODE_FIXTURE.ref, generation: 1, tz: MEMBER_CODE_FIXTURE.tz, offsetMs: 0, userId: MEMBER, enrolledAt: 0,
    });
    // The club never answers: `whoami` stays in flight for the whole test.
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Promise<Response>(() => undefined);
    }));

    renderPage(<RequireAuth><MyCodePage /></RequireAuth>, { initialEntries: ["/my-code"] });

    expect(await codeOnScreen()).toHaveTextContent(MEMBER_CODE_FIXTURE.anchorToken);
    // Only the session check itself (and the door read beside it) — the code is not re-keyed from
    // the club until the check has said who this is.
    expect(asked.filter((url) => url.includes("/me/code"))).toEqual([]);
  });
});
