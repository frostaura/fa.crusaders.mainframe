import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { PLAYERS_UNSURE, PRIVACY_COPY as COPY } from "@/lib/playersCopy";
import { refuse, renderPage, signIn, signOut, stubFetch, type StubRoute } from "@/test/harness";
import { PrivacySwitches } from "./PrivacySwitches";

/**
 * R19 X19-1.4 — the privacy switch, refused by a busy club (`503 service_busy`, read back: nothing
 * changed), said "Couldn't change … — it's back as it was. Try again." — no cause, and "try again"
 * at once into a club that had just said it was busy. A clash and a rate limit were the same
 * sentence. Each now says its cause, as every other players surface does — a plain 500 too (R19
 * X19-2: the club's system answered with an error); silence and a plain refusal keep their sentence.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

/** The read answers `findable: false` first; `readBack` decides what the look after the write sees. */
function routes(put: StubRoute["respond"], readBack: "unchanged" | "fails" = "unchanged"): StubRoute[] {
  let reads = 0;
  return [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    {
      path: "/api/v1/me/preferences",
      respond: () => {
        reads += 1;
        return reads > 1 && readBack === "fails" ? refuse(503, { error: "service_busy" }) : { findable: false, show_in_leaderboards: false };
      },
    },
    { method: "PUT", path: "/api/v1/me/preferences", respond: put },
  ];
}

async function flip(): Promise<string> {
  renderPage(<PrivacySwitches />);
  fireEvent.click(await screen.findByRole("switch", { name: COPY.findableLabel }, { timeout: 10_000 }));
  const alert = await screen.findByRole("alert", {}, { timeout: 10_000 });
  expect(screen.getByRole("switch", { name: COPY.findableLabel })).toHaveAttribute("aria-checked", "false");
  return alert.textContent ?? "";
}

const label = COPY.findableLabel;

describe("the privacy switch says why it went back (R19 X19-1.4)", () => {
  it("busy, read back unchanged: busy, back as it was, try again in a moment", async () => {
    stubFetch(routes(() => refuse(503, { error: "service_busy" })));
    const said = await flip();
    expect(said).toBe(COPY.saveBusy(label));
    expect(said).toMatch(/too busy/);
    expect(said).toMatch(/in a moment/);
  });

  it("a clash, read back unchanged: someone else was changing your settings, try again now", async () => {
    stubFetch(routes(() => refuse(503, { error: "conflict_retry" })));
    const said = await flip();
    expect(said).toBe(COPY.saveConflict(label));
    expect(said).not.toMatch(/didn't answer|too busy/);
  });

  it("a rate limit: too many requests, with the wait the club gave", async () => {
    stubFetch(routes(() => refuse(429, { error: "rate_limited", retry_after_seconds: 4 })));
    const said = await flip();
    expect(said).toMatch(/^Couldn't change "Let other members find me" — it's back as it was\. Too many requests right now — wait 4 seconds and try again\.$/);
  });

  it("busy, and the look failed too: the busy 'can't tell' sentence (kept from R18)", async () => {
    stubFetch(routes(() => refuse(503, { error: "service_busy" }), "fails"));
    const said = await flip();
    expect(said).toBe(PLAYERS_UNSURE.privacyBusy(label));
  });

  it("a plain 500, read back unchanged: the club's system hit an error (R19 X19-2), never 'didn't answer'", async () => {
    stubFetch(routes(() => refuse(500, {})));
    const said = await flip();
    expect(said).toBe(COPY.saveError(label));
    expect(said).not.toMatch(/didn't answer|too busy/);
  });

  it("a plain 500, and the look failed too: the error's 'can't tell' sentence", async () => {
    stubFetch(routes(() => refuse(500, {}), "fails"));
    expect(await flip()).toBe(PLAYERS_UNSURE.privacyError(label));
  });

  it("silence (a 502 from the gateway), read back unchanged: the plain sentence", async () => {
    stubFetch(routes(() => refuse(502, {})));
    expect(await flip()).toBe(COPY.saveFailed(label));
  });

  it("a plain refusal keeps its own sentence", async () => {
    stubFetch(routes(() => refuse(400, { error: "invalid_preferences" })));
    expect(await flip()).toBe(COPY.saveFailed(label));
  });
});
