import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderPage, signIn, signOut } from "@/test/harness";
import { PauseSwitch } from "@/components/play/PauseSwitch";
import type { Pause } from "@/lib/playApi";

/**
 * R18 X18-4 — the injury pause was the one setting that waited for the club before it turned (the
 * star and the privacy switches turn at once and turn back on a refusal). It now turns the moment
 * it is flipped, stays turned on a yes, and turns back — with the reason beside it — on a no.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

const OFF: Pause = { active: false, started_at: null, weeks_used_this_year: 2, weeks_per_year: 8 };
const ON: Pause = { ...OFF, active: true, started_at: "2026-10-05" };

/** The pause write waits until the test answers it. */
function heldPause() {
  let answer: (status: number, body: unknown) => void = () => undefined;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith("/api/v1/me/play/pause") && init?.method === "POST") {
      return new Promise((resolve) => {
        answer = (status, body) => resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
      });
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
  }));
  return { answer: (status: number, body: unknown) => act(async () => { answer(status, body); await new Promise((r) => setTimeout(r, 20)); }) };
}

function mount(onChanged = vi.fn()) {
  signIn({ isAdmin: false });
  const held = heldPause();
  renderPage(<PauseSwitch pause={OFF} year={2026} onChanged={onChanged} />);
  return { held, onChanged, toggle: () => screen.getByRole("switch") };
}

describe("PauseSwitch — optimistic, with rollback (R18 X18-4)", () => {
  it("turns on the moment it is flipped, before the club answers; a yes keeps it on", async () => {
    const { held, onChanged, toggle } = mount();
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    expect(document.querySelector("[data-pause]")).toHaveAttribute("data-pause", "on");
    await held.answer(200, ON);
    expect(onChanged).toHaveBeenCalledWith(ON);
  });

  it("a refusal turns it back, with the reason beside it", async () => {
    const { held, onChanged, toggle } = mount();
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    await held.answer(409, { error: "pause_allowance_used" });
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
