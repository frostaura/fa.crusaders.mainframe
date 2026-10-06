import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { refuse, signOut } from "@/test/harness";
import type { PlayerPickerDialogProps } from "@/components/players/PlayerPicker";
import { DETAIL_ACTIONS } from "@/lib/playersCopy";
import { ALEX_SEAT, DETAIL_PATH, SAM_SEAT, detail, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({
  PlayerPicker: () => null,
  PlayerPickerDialog: (props: PlayerPickerDialogProps) => (props.open ? (
    <div role="dialog" aria-label={props.title}>
      <button type="button" onClick={() => props.onPick({ kind: "member", userId: "u-pia", name: "Pia van Partner", photoUrl: null })}>Pick Pia</button>
    </div>
  ) : null),
}));

/**
 * R17 L17-6 — an invite refused because the partner is at their daily limit said so in the page's
 * notice, under the floating Invite bar at 320 px / 200 % text, while the keyboard went back to
 * Invite. A refusal is now focused (and brought to the middle of the screen); a success is not.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const notice = () => document.querySelector<HTMLElement>("[data-detail-notice]");

describe("a refused invite takes the keyboard to its reason (R17 L17-6)", () => {
  it("at_daily_limit: the notice names who and has focus", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    serve({ detail: detail({ players: [seat(), SAM_SEAT, ALEX_SEAT] }), extra: [{
      method: "POST", path: `${DETAIL_PATH}/players`,
      respond: () => refuse(409, { error: "at_daily_limit", user_id: "u-pia", name: "Pia van Partner" }),
    }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick Pia" }));
    await waitFor(() => expect(notice()).toHaveTextContent(/Pia/));
    await waitFor(() => expect(document.activeElement).toBe(notice()));
    expect(scrolled).toHaveBeenCalledWith({ block: "center" });
  });

  it("a success leaves focus where it was", async () => {
    serve({ detail: detail({ players: [seat(), SAM_SEAT, ALEX_SEAT] }), extra: [{
      method: "POST", path: `${DETAIL_PATH}/players`,
      body: { booking_id: "b", participants: [{ participant_id: "p-pia", seat: 4, user_id: "u-pia", guest_name: null, status: "invited", share_minutes: 25, invite_token: null, invite_path: null }] },
    }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick Pia" }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ACTIONS.invited("Pia")));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).not.toBe(notice());
  });
});
