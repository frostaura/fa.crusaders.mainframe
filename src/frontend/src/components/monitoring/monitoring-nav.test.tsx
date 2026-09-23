import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MONITORING_TABS } from "./MonitoringSection";
import { routePageName, NOT_FOUND_PAGE_NAME } from "../../lib/routeAnnouncer";

const SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const app = readFileSync(join(SRC, "App.tsx"), "utf8");

/**
 * The Monitoring section's one list of destinations (D3 §3.1, ruling 10; R16, R17).
 *
 * <p>
 * What is held here is the scaffolding every Monitoring page is reconciled against: one list
 * behind the route table and the admin rail, a permanent redirect from every old path, no
 * page-local sub-navigation (the rail IS the navigation now), and Monitoring meaning courts,
 * hardware and control only.
 * </p>
 */

describe("the destination list and the route table are one list", () => {
  it("registers a route for every destination, so nothing links to a dead path", () => {
    for (const tab of MONITORING_TABS) {
      // A nav written out separately from the routes it points at acquires a dead link the
      // first time a path moves, and nothing says so.
      expect(app, `no route for ${tab.to}`).toContain(`path="${tab.to}"`);
    }
  });

  it("names every destination for the announcer, or the tab title is 'Page not found'", () => {
    for (const tab of MONITORING_TABS) {
      expect(routePageName(tab.to), tab.to).not.toBe(NOT_FOUND_PAGE_NAME);
    }
  });

  it("marks only the index as `end`, or every child lights two entries", () => {
    const ends = MONITORING_TABS.filter((t) => t.end);
    expect(ends).toHaveLength(1);
    expect(ends[0].to).toBe("/admin/monitoring");
  });

  // "renders the strip with a 44 px floor in pixels" is RETIRED by R16: there is no strip. The
  // 44px floor is now the admin rail's and section switcher's, tested with them.
});

describe("Monitoring is courts, hardware and control (R17)", () => {
  /**
   * "A person's night" is a view of a MEMBER. It stays reachable at its route until P5 moves it
   * onto the member's own page, but it is no longer a Monitoring destination.
   */
  it("does not list a person's night", () => {
    expect(MONITORING_TABS.map((t) => t.to)).not.toContain("/admin/monitoring/night");
    expect(MONITORING_TABS.map((t) => t.label).join(" ")).not.toMatch(/night/i);
  });

  it("keeps the night's route answering until it moves", () => {
    expect(app).toContain('path="/admin/monitoring/night"');
  });
});

describe("no Monitoring page carries its own section nav (R16)", () => {
  /**
   * The rail (desktop) and the section switcher (phone) are the navigation. A strip of tabs
   * under every page's heading was a second nav naming the same places, one level down, and
   * the first thing to disagree with the rail the day a path moved.
   */
  const PAGES = [
    "pages/monitoring",
    "pages/AdminDoors.tsx",
    "pages/AdminDoorsLog.tsx",
    "pages/AdminDoorsDetail.tsx",
    "pages/AdminDoorsCard.tsx",
    "pages/AdminDevices.tsx",
  ];
  const files = PAGES.flatMap((rel) => {
    const full = join(SRC, rel);
    if (!statSync(full).isDirectory()) return [full];
    return readdirSync(full).filter((n) => /\.tsx$/.test(n) && !n.includes(".test.")).map((n) => join(full, n));
  });

  it.each(files.map((f) => [f.split("/src/")[1], f] as const))("%s renders no Monitoring nav", (_name, file) => {
    const code = readFileSync(file, "utf8");
    expect(code).not.toMatch(/MonitoringNav/);
    expect(code).not.toMatch(/aria-label="Monitoring"/);
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

/*
 * "the attention sentence says both halves" is RETIRED here by R16: the sentence moved with the
 * counts to `lib/adminAttention.ts` (the Admin tab's and the rail's badges), and its wording and
 * its both-halves rule are tested beside it in `components/admin/__tests__/adminNav.test.ts`.
 */

describe("every destination is a real page", () => {
  /**
   * No destination may quietly go back to being a stub, and none may be wired to a component
   * that does not exist. The admin guard is on the ONE parent route (`AdminLayout`), so each
   * child names its page directly.
   */
  it("wires each destination to a page, never to a placeholder, under the admin guard", () => {
    expect(app, "a placeholder is back under Monitoring").not.toContain("MonitoringPlaceholder");
    expect(app).toMatch(/<Route path="\/admin" element=\{<RequireAuth admin>/);
    for (const tab of MONITORING_TABS) {
      const route = new RegExp(`path="${tab.to}"\\s+element=\\{<([A-Za-z]+)\\s*/>`);
      const found = app.match(route);
      expect(found, `${tab.to} does not render a page component`).not.toBeNull();
      // A route is only as real as the import behind it.
      expect(app, `${tab.to} renders <${found?.[1]}>, which nothing imports`)
        .toMatch(new RegExp(`import \\{[^}]*\\b${found?.[1]}\\b`));
    }
  });
});
