import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MONITORING_TABS, MonitoringNav, MonitoringPlaceholder } from "./MonitoringSection";
import { monitoringAttentionLabel } from "../Layout";
import { routePageName, NOT_FOUND_PAGE_NAME } from "../../lib/routeAnnouncer";

const SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const app = readFileSync(join(SRC, "App.tsx"), "utf8");

/**
 * The Monitoring section's shell (D3 §3.1, ruling 10).
 *
 * <p>
 * The pages belong to the admin lane. What is held here is the scaffolding that has to be
 * right on the day they land: one list behind the sub-nav and the route table, a permanent
 * redirect from every old path, and an attention sentence that says both halves.
 * </p>
 */

describe("the sub-nav and the route table are one list", () => {
  it("registers a route for every tab, so the strip has no dead link", () => {
    for (const tab of MONITORING_TABS) {
      // A sub-nav written out separately from the routes it points at acquires a dead link
      // the first time a path moves, and nothing says so.
      expect(app, `no route for ${tab.to}`).toContain(`path="${tab.to}"`);
    }
  });

  it("names every tab for the announcer, or the tab title is 'Page not found'", () => {
    for (const tab of MONITORING_TABS) {
      expect(routePageName(tab.to), tab.to).not.toBe(NOT_FOUND_PAGE_NAME);
    }
  });

  it("marks only the index as `end`, or every child lights two tabs", () => {
    const ends = MONITORING_TABS.filter((t) => t.end);
    expect(ends).toHaveLength(1);
    expect(ends[0].to).toBe("/admin/monitoring");
  });

  it("renders the strip with a 44 px floor in pixels", () => {
    render(<MemoryRouter initialEntries={["/admin/monitoring"]}><MonitoringNav /></MemoryRouter>);
    for (const tab of MONITORING_TABS) {
      const link = screen.getByRole("link", { name: tab.label });
      // B12: a touch target is a fingertip and does not double with the text.
      expect(link.className).toContain("[@media(pointer:coarse)]:min-h-[44px]");
    }
  });
});

describe("the old URLs keep working", () => {
  /**
   * Permanent redirects, not deletions — the same decision as `/court-code`.
   *
   * These paths are in outage emails, in bookmarks, and printed on the door card that lives
   * in a cupboard beside the board. `AdminDeviceApiKeyPanel`'s pairing instructions point at
   * one of them.
   */
  it.each([
    "/admin/devices",
    "/admin/doors",
    "/admin/doors/log",
    "/admin/doors/:id",
    "/admin/doors/:id/card",
  ])("still declares %s", (path) => {
    expect(app).toContain(`path="${path}"`);
  });

  it("carries a door's id across rather than dropping it on the fleet list", () => {
    // A bare `<Navigate to="/admin/monitoring/doors" />` on `/admin/doors/:id` would send a
    // bookmark for ONE door to the list of all of them, which is the failure a redirect
    // exists to prevent.
    expect(app).toMatch(/path="\/admin\/doors\/:id"\s+element=\{<RedirectDoor\s*\/>\}/);
    expect(app).toMatch(/path="\/admin\/doors\/:id\/card"\s+element=\{<RedirectDoor card\s*\/>\}/);
    expect(app).toContain("`${base}/card`");
  });

  it("keeps the query string, which is where the door log's filter lives", () => {
    /*
     * `<Navigate to="/new" replace />` discards `location.search`. Measured: the redirect
     * landed `/admin/doors/log?door=<id>` on the new path with no filter, so a link an admin
     * had sent a colleague — or one out of an outage email, which is why these redirects
     * exist at all — arrived showing every scan in the club. Two e2e specs went red on it.
     *
     * So every old path goes through one of the two helpers, and neither may be a bare
     * `Navigate`.
     */
    const oldRoutes = [...app.matchAll(/<Route path="(\/admin\/(?:doors|devices)[^"]*)" element=\{<([A-Za-z]+)/g)];
    expect(oldRoutes.length).toBeGreaterThanOrEqual(5);
    for (const [, path, element] of oldRoutes) {
      expect(["RedirectKeepingQuery", "RedirectDoor"], `${path} redirects via <${element}>`).toContain(element);
    }
    expect(app).toContain("`${to}${search}${hash}`");
  });

  it("uses `replace`, so Back does not bounce between the two paths", () => {
    // Without it, Back from the new URL lands on the old one, which redirects forward again.
    expect(app).toMatch(/function RedirectKeepingQuery[\s\S]{0,300}?<Navigate to=\{`\$\{to\}\$\{search\}\$\{hash\}`\} replace \/>/);
  });
});

describe("the attention sentence says both halves", () => {
  it("counts doors, as it always did", () => {
    expect(monitoringAttentionLabel(1)).toBe("1 door needs attention");
    expect(monitoringAttentionLabel(2)).toBe("2 doors need attention");
  });

  it("adds boards once there are any, without any caller changing", () => {
    // An admin who sees a number on Monitoring and finds every door fine concludes the badge
    // is wrong. The section covers both, so the sentence has to.
    expect(monitoringAttentionLabel(2, 1)).toBe("2 doors need attention and 1 board has a fault");
    expect(monitoringAttentionLabel(0, 2)).toBe("2 boards have a fault");
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(monitoringAttentionLabel(0)).toBe("");
    expect(monitoringAttentionLabel(0, 0)).toBe("");
  });
});

describe("an unbuilt destination says so", () => {
  it("is honest rather than empty, and is not an alert", () => {
    render(
      <MemoryRouter initialEntries={["/admin/monitoring/faults"]}>
        <MonitoringPlaceholder title="Faults" what="The board fault log" />
      </MemoryRouter>,
    );
    // A nav entry that 404s teaches an admin that the console is broken.
    expect(screen.getByRole("heading", { name: "Faults", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/isn't built yet/);
    // Nothing has gone wrong; an alert interrupts and this is a standing fact.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
