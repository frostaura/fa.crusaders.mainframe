import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { refuse, renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { PICKER, PLAYERS_UNSURE, PRIVACY_COPY } from "@/lib/playersCopy";
import { PlayerPicker } from "../PlayerPicker";
import { PrivacySwitches } from "../privacy/PrivacySwitches";

/**
 * The lost-reply audit (R3) of a member's own toggles: the favourite star and the privacy
 * switch. Each stub PERFORMS the write and then loses the reply: the toggle reads back and
 * keeps what the club now holds — it used to flip back over a change that had saved.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

const SAM = { user_id: "sam", name: "Sam Petersen", photo_url: null };
const lost = () => refuse(504, { error: "gateway_timeout" });

describe("the star", () => {
  it("an unstar that landed behind a 504 stays unstarred, with no failure", async () => {
    let starred = true;
    const stub = stubFetch([
      { path: "/api/v1/me/partners/favourites", respond: () => ({ items: starred ? [SAM] : [] }) },
      { path: "/api/v1/me/partners/recent", body: { items: [] } },
      { method: "DELETE", path: "/api/v1/me/partners/favourites/sam", respond: () => { starred = false; return lost(); } },
    ]);
    renderPage(<PlayerPicker onPick={() => undefined} excludeUserIds={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: PICKER.unstar(SAM.name) }));
    // The read-back: the favourites asked for again after the lost reply.
    await waitFor(() => expect(stub.calls.filter((c) => c.path === "/api/v1/me/partners/favourites").length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => { setTimeout(r, 100); });
    // Off the Favourites tab it stays off: never flipped back as though the unstar had failed.
    expect(screen.queryByRole("button", { name: PICKER.unstar(SAM.name) })).toBeNull();
    expect(screen.queryByText(PICKER.starFailed(SAM.name))).toBeNull();
  });

  it("when even the read-back fails, it says it cannot tell — not 'nothing changed'", async () => {
    let reads = 0;
    stubFetch([
      { path: "/api/v1/me/partners/favourites", respond: () => { reads += 1; return reads === 1 ? { items: [SAM] } : lost(); } },
      { path: "/api/v1/me/partners/recent", body: { items: [] } },
      { method: "DELETE", path: "/api/v1/me/partners/favourites/sam", respond: lost },
    ]);
    renderPage(<PlayerPicker onPick={() => undefined} excludeUserIds={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: PICKER.unstar(SAM.name) }));
    expect(await screen.findByText(PLAYERS_UNSURE.star(SAM.name))).toBeInTheDocument();
  });
});

describe("the privacy switch", () => {
  it("a switch that saved behind a 504 stays on, with no failure", async () => {
    let findable = false;
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/me/preferences", respond: () => ({ findable }) },
      { method: "PUT", path: "/api/v1/me/preferences", respond: () => { findable = true; return lost(); } },
    ]);
    renderPage(<PrivacySwitches />);
    const toggle = await screen.findByRole("switch", { name: PRIVACY_COPY.findableLabel });
    fireEvent.click(toggle);
    await waitFor(() => expect(findable).toBe(true));
    await waitFor(() => expect(screen.getByRole("switch", { name: PRIVACY_COPY.findableLabel })).not.toHaveAttribute("aria-busy", "true"));
    expect(screen.getByRole("switch", { name: PRIVACY_COPY.findableLabel })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText(PRIVACY_COPY.saveFailed(PRIVACY_COPY.findableLabel))).toBeNull();
  });
});
