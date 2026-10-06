import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Minutes } from "./Minutes";
import { signOut } from "@/test/harness";
import { DETAIL_MONEY } from "@/lib/playersCopy";
import { renderDetail, serve } from "@/components/players/__tests__/detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R19 L19-3 (the class, at its root) — `<Minutes>` painted "1 h 30 min" with ordinary spaces, so
 * every screen that draws one could break "1 h 30 / min" at large text; and the booking page's
 * money panel broke its deadline "Wed 7 / Oct". Paint glued; what a reader hears is unchanged.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

const SPLITTABLE = /\d [\p{L}]/u;

describe("figures glued at the root (R19 L19-3)", () => {
  it("<Minutes> paints each figure glued to its unit; the spoken form is plain", () => {
    const { container } = render(<Minutes value={90} />);
    const painted = container.querySelector("[aria-hidden]")!.textContent!;
    expect(painted).toBe("1 h 30 min");
    expect(screen.getByText("1 hour 30 minutes")).toBeInTheDocument();
  });

  it("the money panel's deadline and unpaid line keep '2 Oct' whole", async () => {
    serve();
    renderDetail();
    const money = await screen.findByRole("region", { name: DETAIL_MONEY.title }, { timeout: 10_000 });
    const painted = [...money.querySelectorAll("p, span, div")]
      .filter((n) => n.children.length === 0 && /Oct/.test(n.textContent ?? ""))
      .map((n) => n.textContent ?? "");
    expect(painted.length).toBeGreaterThan(0);
    for (const t of painted) expect(t).not.toMatch(SPLITTABLE);
    expect(within(money).getByText(DETAIL_MONEY.deadline("Fri 2 Oct, 20:45"))).toBeInTheDocument();
  });
});
