import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { refuse, renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { PICKER, PLAYERS_UNSURE, PRIVACY_COPY } from "@/lib/playersCopy";
import { PlayerPicker, PlayerPickerDialog } from "../PlayerPicker";
import { PrivacySwitches } from "../privacy/PrivacySwitches";

/**
 * Review round 18, lane FE18m — the picker and the member's own toggles.
 *
 * <ul>
 *   <li><b>L17-6</b> (partly fixed in R17) — an invite refused while the picker was still closing:
 *   the refusal took focus at ~65ms, then the picker's close (~300ms) put it back on Invite.</li>
 *   <li><b>X18-1</b> — a star or a privacy switch answered `503 conflict_retry` (and unreadable after)
 *   said "The club didn't answer".</li>
 * </ul>
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

const SAM = { user_id: "sam", name: "Sam Petersen", photo_url: null };

function Page({ refused }: { refused: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Invite a player</button>
      {/* The booking page's notice: what the page focuses when the pick is refused. */}
      <div data-detail-notice="n1" tabIndex={-1} role="alert">{refused ? "Pia is at her daily limit." : ""}</div>
      <PlayerPickerDialog
        open={open}
        onOpenChange={setOpen}
        title="Invite a player"
        excludeUserIds={[]}
        onPick={() => {
          setOpen(false);
          // The add's refusal lands while the picker is still animating closed (~65ms of ~300).
          if (refused) window.setTimeout(() => document.querySelector<HTMLElement>("[data-detail-notice]")?.focus(), 0);
        }}
      />
    </>
  );
}

/**
 * jsdom runs no animations, so a Radix dialog unmounts the instant it closes and the race never
 * happens. Here the closing dialog reports an exit animation, so it stays mounted (closed, focus no
 * longer trapped) until the test ends the animation — as a phone does for ~300ms.
 */
function animatedClose() {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
    const style = real(el, pseudo);
    if (!(el instanceof HTMLElement) || el.dataset.dialog !== "player-picker" || el.dataset.state !== "closed") return style;
    return new Proxy(style, { get: (target, key) => (key === "animationName" ? "sheet-out" : Reflect.get(target, key)) });
  });
  return async () => {
    const content = document.querySelector<HTMLElement>('[data-dialog="player-picker"]');
    if (!content) return;
    await act(async () => { content.dispatchEvent(Object.assign(new Event("animationend", { bubbles: true }), { animationName: "sheet-out" })); });
  };
}

describe("the picker's close leaves a refusal's focus where it is (R18 / L17-6)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function routes() {
    stubFetch([
      { path: "/api/v1/me/partners/favourites", body: { items: [SAM] } },
      { path: "/api/v1/me/partners/recent", body: { items: [] } },
    ]);
  }

  it("refused: the notice keeps focus after the picker has closed", async () => {
    routes();
    renderPage(<Page refused />);
    const invite = screen.getByRole("button", { name: "Invite a player" });
    invite.focus();
    fireEvent.click(invite);
    const endClose = animatedClose();
    fireEvent.click(await screen.findByRole("button", { name: PICKER.add(SAM.name) }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    // Still closing, and the refusal already has focus.
    expect(document.activeElement).toBe(document.querySelector("[data-detail-notice]"));
    await endClose();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(document.querySelector('[data-dialog="player-picker"]')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-detail-notice]"));
  });

  it("not refused: focus goes back to Invite, as before", async () => {
    routes();
    renderPage(<Page refused={false} />);
    const invite = screen.getByRole("button", { name: "Invite a player" });
    invite.focus();
    fireEvent.click(invite);
    const endClose = animatedClose();
    fireEvent.click(await screen.findByRole("button", { name: PICKER.add(SAM.name) }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await endClose();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(document.activeElement).toBe(invite);
  });
});

describe("conflict_retry on the member's own toggles (R18 X18-1)", () => {
  const conflict = () => refuse(503, { error: "conflict_retry" });

  it("the star: 'someone else was changing your favourites' — never 'didn't answer'", async () => {
    let reads = 0;
    stubFetch([
      { path: "/api/v1/me/partners/favourites", respond: () => { reads += 1; return reads === 1 ? { items: [SAM] } : refuse(504, { error: "gateway_timeout" }); } },
      { path: "/api/v1/me/partners/recent", body: { items: [] } },
      { method: "DELETE", path: "/api/v1/me/partners/favourites/sam", respond: conflict },
    ]);
    renderPage(<PlayerPicker onPick={() => undefined} excludeUserIds={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: PICKER.unstar(SAM.name) }));
    expect(await screen.findByText(PLAYERS_UNSURE.starConflict(SAM.name))).toBeInTheDocument();
    expect(screen.queryByText(/didn't answer/)).toBeNull();
  });

  it("a privacy switch: the same", async () => {
    let reads = 0;
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/me/preferences", respond: () => { reads += 1; return reads === 1 ? { findable: false } : refuse(504, { error: "gateway_timeout" }); } },
      { method: "PUT", path: "/api/v1/me/preferences", respond: conflict },
    ]);
    renderPage(<PrivacySwitches />);
    fireEvent.click(await screen.findByRole("switch", { name: PRIVACY_COPY.findableLabel }));
    expect(await screen.findByText(PLAYERS_UNSURE.privacyConflict(PRIVACY_COPY.findableLabel))).toBeInTheDocument();
    expect(screen.queryByText(/didn't answer/)).toBeNull();
  });
});
