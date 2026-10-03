import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { DETAIL_ATTENDANCE } from "@/lib/playersCopy";
import { detail, renderDetail, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R9 E9-7 — one end time for a booking on every screen. A no-show reversed by a late check-in has
 * its `ends_at` narrowed to when the relay went dark (12:22) while it was SOLD to 12:23; the
 * member's page said 12:08–12:22 and the admin's 12:08–12:23. The hours are the sold end
 * everywhere; where the lights went off earlier, that is said on its own line.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 18:00–18:45 sold (Johannesburg); the court went dark at 18:44.
const PLAYED = {
  ends_at: "2026-09-30T16:44:00Z", sold_ends_at: "2026-09-30T16:45:00Z",
  attendance: { checked_in_at: "2026-09-30T16:01:00Z", players_checked_in: 1 },
};

describe("E9-7 — the sold end, and the lights-off time beside it", () => {
  it("titles a played game with the end it was sold to and says when the lights went off", async () => {
    serve({ detail: detail(PLAYED) });
    renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: /18:00–18:45/ })).toBeInTheDocument();
    expect(screen.getByText(DETAIL_ATTENDANCE.lightsOffAt("18:44"))).toBeInTheDocument();
  });

  it("says no lights-off line when the game ran to its sold end", async () => {
    serve({ detail: detail({ attendance: PLAYED.attendance }) });
    renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: /18:00–18:45/ })).toBeInTheDocument();
    expect(screen.queryByText(/Lights off/)).toBeNull();
  });

  it("a no-show keeps the sold end and claims no lights-off time (its ends_at is the sweep's cut)", async () => {
    serve({ detail: detail({ status: "no_show", ends_at: "2026-09-30T16:10:00Z", sold_ends_at: "2026-09-30T16:45:00Z" }) });
    renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: /18:00–18:45/ })).toBeInTheDocument();
    expect(screen.queryByText(/Lights off/)).toBeNull();
  });
});
