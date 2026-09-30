import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { refuse, renderPage, signOut } from "@/test/harness";
import { MyGameSection } from "@/components/play/MyGameSection";
import AdminResultsPage from "@/pages/admin/AdminResults";
import type { MyPlay } from "@/lib/playApi";
import { ADMIN_RESULT_UNSURE, ADMIN_RESULTS, GOAL_SHEET, MY_GAME, PLAY_SETTINGS_UNSURE, RESULT_LOST, RING_COPY } from "@/lib/playCopy";
import { adminResult, myPlay, RESULT_ID, serve } from "./playKit";

/**
 * The lost-reply audit (R3) of the play writes that are not a result: the member's pause and
 * goal, and the admin's decision on a result. Each stub PERFORMS the write and then loses the
 * reply; the screen reads back and says what it finds.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const PLAY = "/api/v1/me/play";
const lost = () => refuse(504, { error: "gateway_timeout" });

function me(first: MyPlay) {
  let current = first;
  return {
    route: { path: PLAY, respond: () => current },
    lands: (next: MyPlay) => () => { current = next; return lost(); },
  };
}

describe("My game", () => {
  it("a pause that landed behind a 504 shows as on, with no failure", async () => {
    const on = myPlay({ pause: { active: true, started_at: "2026-09-29T17:00:00Z", weeks_used_this_year: 3, weeks_per_year: 8 } });
    const m = me(myPlay());
    serve([m.route, { method: "POST", path: `${PLAY}/pause`, respond: m.lands(on) }]);
    renderPage(<MyGameSection />);
    const region = await screen.findByRole("region", { name: MY_GAME.title });
    const box = await waitFor(() => { const found = region.querySelector("[data-pause]"); expect(found).not.toBeNull(); return found as HTMLElement; });
    fireEvent.click(within(box).getByRole("switch"));
    await waitFor(() => expect(region.querySelector("[data-pause]")).toHaveAttribute("data-pause", "on"));
    expect(region.querySelector("[role=alert]")).toBeNull();
  });

  it("a pause that did not land says it is as it was", async () => {
    serve([{ path: PLAY, body: myPlay() }, { method: "POST", path: `${PLAY}/pause`, respond: lost }]);
    renderPage(<MyGameSection />);
    const region = await screen.findByRole("region", { name: MY_GAME.title });
    const box = await waitFor(() => { const found = region.querySelector("[data-pause]"); expect(found).not.toBeNull(); return found as HTMLElement; });
    fireEvent.click(within(box).getByRole("switch"));
    expect(await screen.findByText(PLAY_SETTINGS_UNSURE.pause.checked)).toBeInTheDocument();
  });

  it("a goal removal that landed behind a 504 closes the sheet as removed", async () => {
    const m = me(myPlay());
    serve([m.route, { method: "PUT", path: `${PLAY}/settings`, respond: m.lands(myPlay({ ring: null, settings: { monthly_goal_minutes: null, celebrations_enabled: true } })) }]);
    renderPage(<MyGameSection />);
    fireEvent.click(await screen.findByRole("button", { name: RING_COPY.editGoal }));
    const dialog = await screen.findByRole("dialog", { name: GOAL_SHEET.title });
    fireEvent.click(within(dialog).getByRole("button", { name: GOAL_SHEET.remove }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("the admin's decision on a result", () => {
  const LIST = "/api/v1/admin/play/results";
  const page = (items: unknown[]) => ({ items, next_cursor: null, count: items.length });

  function routes(voided: () => unknown[], voidRoute: () => unknown) {
    return serve([
      { path: `${LIST}?status=disputed`, body: page([adminResult()]) },
      { path: `${LIST}?status=voided`, respond: () => page(voided()) },
      { path: `${LIST}/disputed/count`, body: { count: 1 } },
      { method: "POST", path: `${LIST}/${RESULT_ID}/void`, respond: voidRoute },
    ], { admin: true });
  }

  async function removeWithReason() {
    renderPage(<AdminResultsPage />);
    fireEvent.click(await screen.findByRole("button", { name: ADMIN_RESULTS.remove }));
    const dialog = screen.getByRole("dialog", { name: ADMIN_RESULTS.removeTitle });
    fireEvent.change(within(dialog).getByLabelText(ADMIN_RESULTS.reasonLabel), { target: { value: "Wrong score" } });
    fireEvent.click(within(dialog).getByRole("button", { name: ADMIN_RESULTS.remove }));
  }

  it("a removal that landed behind a 504 drops the row and says it was removed", async () => {
    let done = false;
    routes(() => (done ? [{ ...adminResult(), status: "voided" }] : []), () => { done = true; return lost(); });
    await removeWithReason();
    await waitFor(() => expect(document.querySelector(`[data-admin-result="${RESULT_ID}"]`)).toBeNull());
    expect((await screen.findAllByText(RESULT_LOST(ADMIN_RESULTS.removed))).length).toBeGreaterThan(0);
  });

  it("a removal that did not land says the result is still on the list", async () => {
    routes(() => [], lost);
    await removeWithReason();
    expect(await screen.findByText(ADMIN_RESULT_UNSURE.void.checked)).toBeInTheDocument();
    expect(document.querySelector(`[data-admin-result="${RESULT_ID}"]`)).not.toBeNull();
  });
});
