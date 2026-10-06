import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { RECENT, UPCOMING } from "@/lib/bookingsCopy";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { UpcomingGames } from "./UpcomingGames";
import { RecentGames } from "./RecentGames";

/**
 * R19 L19-7 / X19-1.4 — a failed read of the member's games named no cause: "Couldn't load your
 * upcoming games." for a busy club, a rate limit and a clash alike, where Profile and Invites say
 * which ("the club's system is very busy right now. Try again in a moment."). The line now says
 * the read's own cause after it — and still never "no games".
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

const CASES = [
  { name: "503 service_busy", status: 503, body: { error: "service_busy" }, says: /very busy right now\. Try again in a moment\./, not: /down or restarting|connection/ },
  { name: "429 rate_limited", status: 429, body: { error: "rate_limited", retry_after_seconds: 3 }, says: /Too many requests right now — wait 3 seconds/, not: /down or restarting|connection/ },
  { name: "503 conflict_retry", status: 503, body: { error: "conflict_retry" }, says: /Someone else was changing the same thing at that exact moment/, not: /down or restarting|connection|has the latest/ },
  { name: "a plain 500", status: 500, body: {}, says: /Something went wrong on the club's system/, not: /connection/ },
] as const;

const LISTS = [
  { which: "upcoming", path: "/api/v1/me/bookings/upcoming", failed: UPCOMING.failed, render: () => <UpcomingGames refreshKey={0} /> },
  { which: "recent", path: "/api/v1/me/bookings/recent", failed: RECENT.failed, render: () => <RecentGames refreshKey={0} /> },
] as const;

describe("the games lists say why their read failed (R19 L19-7)", () => {
  for (const list of LISTS) {
    for (const c of CASES) {
      it(`${list.which}: ${c.name} is said with its cause, and a retry`, async () => {
        stubFetch([
          { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
          { path: list.path, status: c.status, body: c.body },
        ]);
        renderPage(list.render());
        const lead = await screen.findByText(list.failed, {}, { timeout: 10_000 });
        const line = lead.closest(`[data-${list.which}]`) as HTMLElement;
        expect(line.textContent).toMatch(c.says);
        expect(line.textContent).not.toMatch(c.not);
        expect(screen.getByRole("button", { name: UPCOMING.retry })).toBeInTheDocument();
      });
    }
  }
});
