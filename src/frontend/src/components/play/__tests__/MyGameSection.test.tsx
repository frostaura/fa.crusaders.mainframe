import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderPage, signOut } from "@/test/harness";
import { MyGameSection } from "@/components/play/MyGameSection";
import {
  BADGES_COPY, CELEBRATIONS_SWITCH, GOAL_SHEET, MY_GAME, PAUSE_COPY, PEOPLE_COPY, RING_COPY, STATS_COPY, STREAK_COPY,
  goalMinutesFrom,
  readGoal,
} from "@/lib/playCopy";
import { AMOUNT_COPY } from "@/lib/amountCopy";
import { myPlay, serve } from "./playKit";

/**
 * "My game" (§9.1): the ring only with a goal, the streak strip's five states, the figures, form
 * and people, badges earned and locked — and the member's own three settings (goal, pause,
 * celebrations), each checked by what it SENDS.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const PLAY = "/api/v1/me/play";

/** A part of the section, once the read has answered. */
async function part(selector: string): Promise<HTMLElement> {
  await screen.findByText(STREAK_COPY.current(6));
  const found = document.querySelector(selector);
  expect(found).not.toBeNull();
  return found as HTMLElement;
}

async function render(routes: Parameters<typeof serve>[0] = [{ path: PLAY, body: myPlay() }]) {
  const stub = serve(routes);
  renderPage(<MyGameSection />);
  const region = await screen.findByRole("region", { name: MY_GAME.title });
  return { stub, region };
}

describe("reading", () => {
  it("is headed My game, says only you can see it, and is the #my-game anchor", async () => {
    const { region } = await render();
    expect(region).toHaveAttribute("id", MY_GAME.anchor);
    expect(region).toHaveTextContent(MY_GAME.description);
  });

  it("a failed read is a failure with a retry — never zeros", async () => {
    let calls = 0;
    await render([{ path: PLAY, respond: () => { calls += 1; if (calls === 1) throw new TypeError("Failed to fetch"); return myPlay(); } }]);
    const retry = await screen.findByRole("button", { name: /try again/i });
    expect(document.querySelector("[data-stats]")).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByText(STREAK_COPY.current(6))).toBeInTheDocument();
  });
});

describe("the ring", () => {
  it("says both figures in its name", async () => {
    await render();
    expect(await screen.findByRole("img", { name: RING_COPY.aria(405, 600) })).toBeInTheDocument();
    expect(screen.getByText(RING_COPY.caption(600))).toBeInTheDocument();
  });

  it("is hidden without a goal, which is offered instead", async () => {
    await render([{ path: PLAY, body: myPlay({ ring: null, settings: { monthly_goal_minutes: null, celebrations_enabled: true } }) }]);
    expect(await screen.findByRole("button", { name: RING_COPY.setGoal })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /goal this month/ })).toBeNull();
  });

  it("sets a goal in hours, sent as minutes", async () => {
    const { stub } = await render([
      { path: PLAY, body: myPlay({ ring: null, settings: { monthly_goal_minutes: null, celebrations_enabled: true } }) },
      { method: "PUT", path: `${PLAY}/settings`, body: { monthly_goal_minutes: 450, celebrations_enabled: true } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: RING_COPY.setGoal }));
    const dialog = await screen.findByRole("dialog", { name: GOAL_SHEET.title });
    const hours = within(dialog).getByLabelText(GOAL_SHEET.label);
    fireEvent.change(hours, { target: { value: "7.3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: GOAL_SHEET.save }));
    expect(await within(dialog).findByText(GOAL_SHEET.outOfRange)).toBeInTheDocument();
    fireEvent.change(hours, { target: { value: "7.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: GOAL_SHEET.save }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stub.calls.find((c) => c.method === "PUT")?.body).toEqual({ monthlyGoalMinutes: 450 });
  });

  it("removes a goal with null", async () => {
    const { stub } = await render([
      { path: PLAY, body: myPlay() },
      { method: "PUT", path: `${PLAY}/settings`, body: { monthly_goal_minutes: null, celebrations_enabled: true } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: RING_COPY.editGoal }));
    const dialog = await screen.findByRole("dialog", { name: GOAL_SHEET.title });
    expect(within(dialog).getByLabelText(GOAL_SHEET.label)).toHaveValue("10");
    fireEvent.click(within(dialog).getByRole("button", { name: GOAL_SHEET.remove }));
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT")?.body).toEqual({ monthlyGoalMinutes: null }));
  });

  it("reads hours the way the server bounds minutes", () => {
    expect(goalMinutesFrom("0.5")).toBe(30);
    expect(goalMinutesFrom("100")).toBe(6000);
    expect(goalMinutesFrom("0.25")).toBeNull();
    expect(goalMinutesFrom("100.25")).toBeNull();
    expect(goalMinutesFrom("1,75")).toBe(105);
    expect(goalMinutesFrom("abc")).toBeNull();
  });

  it("reads the goal with the club's one amount parser, and says a bad one in words (R1, from F3)", () => {
    expect(goalMinutesFrom("1e3")).toBeNull();
    expect(readGoal("1e3")).toEqual({ ok: false, sentence: GOAL_SHEET.notANumber });
    expect(readGoal("")).toEqual({ ok: false, sentence: GOAL_SHEET.empty });
    expect(readGoal("-2")).toEqual({ ok: false, sentence: AMOUNT_COPY.negative });
    // Zero is a number (allowZero) — and then outside the goal's range, said as such.
    expect(readGoal("0")).toEqual({ ok: false, sentence: GOAL_SHEET.outOfRange });
    expect(readGoal(" 7,5 ")).toEqual({ ok: true, minutes: 450 });
  });
});

describe("the streak", () => {
  it("shows the run, the longest, the banked rest week and the rule — and no warning", async () => {
    const { region } = await render();
    await screen.findByText(STREAK_COPY.current(6));
    expect(region).toHaveTextContent(STREAK_COPY.longest(11));
    expect(region).toHaveTextContent(STREAK_COPY.banked(1));
    expect(region).toHaveTextContent(STREAK_COPY.rule(4, 2));
    expect(region.textContent).not.toMatch(/at risk|lose|don't break/i);
  });

  it("draws twelve weeks, each named in words", async () => {
    await render();
    const strip = await screen.findByRole("list", { name: STREAK_COPY.stripLabel });
    const cells = within(strip).getAllByRole("listitem");
    expect(cells).toHaveLength(12);
    expect(cells.map((c) => c.getAttribute("data-week-state"))).toEqual([
      "attended", "missed", "paused", "attended", "rest", "attended", "attended", "attended", "attended", "attended", "attended", "pending",
    ]);
    expect(cells[4]).toHaveTextContent("Week of 2026-08-10: rest week");
  });

  it("turns the injury pause on, and says what is left", async () => {
    const { stub, region } = await render([
      { path: PLAY, body: myPlay() },
      { method: "POST", path: `${PLAY}/pause`, body: { active: true, started_at: "2026-09-29T17:00:00Z", weeks_used_this_year: 3, weeks_per_year: 8 } },
    ]);
    await screen.findByText(STREAK_COPY.current(6));
    expect(region).toHaveTextContent(PAUSE_COPY.hint(6, 8, 2026));
    const pause = within(region.querySelector("[data-pause]") as HTMLElement).getByRole("switch");
    fireEvent.click(pause);
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path === `${PLAY}/pause`)).toBe(true));
    await waitFor(() => expect(region.querySelector("[data-pause]")).toHaveAttribute("data-pause", "on"));
  });

  it("says a used-up allowance, and does not offer a switch that could only be refused", async () => {
    const { region } = await render([{ path: PLAY, body: myPlay({ pause: { active: false, started_at: null, weeks_used_this_year: 8, weeks_per_year: 8 } }) }]);
    await screen.findByText(STREAK_COPY.current(6));
    expect(region).toHaveTextContent(PAUSE_COPY.usedUp(8, 2026));
    expect(within(region.querySelector("[data-pause]") as HTMLElement).getByRole("switch")).toBeDisabled();
  });
});

describe("figures, form and people", () => {
  it("shows the stats in words and numbers", async () => {
    await render();
    const stats = await part("[data-stats]");
    expect(stats).toHaveTextContent(`${STATS_COPY.sessions}58`);
    expect(stats).toHaveTextContent("43 h 30 min");
    expect(stats).toHaveTextContent(`${STATS_COPY.matches}12–9`);
    expect(stats).toHaveTextContent(`${STATS_COPY.winRate}57%`);
  });

  it("the win rate is a dash with no matches, never 0%", async () => {
    const base = myPlay();
    await render([{ path: PLAY, body: myPlay({ stats: { ...base.stats, matches_played: 0, matches_won: 0, matches_lost: 0, win_rate_percent: null } }) }]);
    const stats = await part("[data-stats]");
    expect(stats).toHaveTextContent(`${STATS_COPY.winRate}${STATS_COPY.noMatches}`);
  });

  it("form chips carry the letter, people their counts, and a link to every result", async () => {
    await render();
    const form = await screen.findByRole("list", { name: PEOPLE_COPY.formHint });
    expect(within(form).getAllByRole("listitem").map((li) => li.getAttribute("data-outcome"))).toEqual(["won", "lost"]);
    expect([...form.querySelectorAll('[aria-hidden="true"]')].map((el) => el.textContent)).toEqual([PEOPLE_COPY.won, PEOPLE_COPY.lost]);
    expect(within(form).getAllByRole("listitem")[0]).toHaveTextContent(/won, Wed 30 Sep, 18:00/);
    expect(document.querySelector("[data-partners]")).toHaveTextContent(PEOPLE_COPY.sessionsWith(14));
    expect(document.querySelector("[data-opponents]")).toHaveTextContent(PEOPLE_COPY.headToHeadLabel("Sam Petersen", 4, 2));
    expect(screen.getByRole("link", { name: new RegExp(PEOPLE_COPY.allResults) })).toHaveAttribute("href", "/profile/results");
  });
});

describe("badges", () => {
  it("earned in colour with a date, locked with progress, and a tap opens the description", async () => {
    await render();
    const earned = await screen.findByRole("button", { name: /^Regular, Earned 14 Aug 2026$/ });
    expect(earned.closest("[data-badge]")).toHaveAttribute("data-earned", "true");
    const locked = screen.getByRole("button", { name: `Centurion, ${BADGES_COPY.progressLabel(58, 100)}` });
    expect(locked).toHaveTextContent(BADGES_COPY.progress(58, 100));
    expect(screen.getByRole("button", { name: `Night owl, ${BADGES_COPY.locked}` })).toBeInTheDocument();
    fireEvent.click(locked);
    expect(await screen.findByText("Played 100 sessions.")).toBeInTheDocument();
  });
});

describe("celebrations switch", () => {
  it("saves the moment it is flipped", async () => {
    const { stub, region } = await render([
      { path: PLAY, body: myPlay() },
      { method: "PUT", path: `${PLAY}/settings`, body: { monthly_goal_minutes: 600, celebrations_enabled: false } },
    ]);
    const row = await part('[data-my-game-part="celebrations"]');
    expect(region).toContainElement(row);
    expect(row).toHaveTextContent(CELEBRATIONS_SWITCH.hint);
    const toggle = within(row).getByRole("switch", { name: CELEBRATIONS_SWITCH.label });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(stub.calls.find((c) => c.method === "PUT")?.body).toEqual({ celebrationsEnabled: false });
  });
});
