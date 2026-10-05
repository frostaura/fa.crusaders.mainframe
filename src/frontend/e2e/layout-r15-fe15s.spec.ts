import { type Page } from "@playwright/test";
import { SESSION_ADMIN, SESSION_ANON, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 15, lane FE15s — layout, measured in Chromium.
 *
 * <ul>
 *   <li><b>L15-1</b>: a focused row in a list that clips (`overflow-hidden`) draws its ring INSIDE
 *       itself — the inbox's and the admin alerts' rows had their rings cut off at the list's edge.</li>
 *   <li><b>L15-3</b>: the member record's terms sit beside their values by the RECORD's box (rem
 *       container), in a column as wide as the longest term; the address breaks at "@" and dots.</li>
 *   <li><b>L15-4</b>: under a 14rem box an alert's mark stands on its own line, so a long first word
 *       keeps the full width ("Bartholome/w" split beside the floated mark).</li>
 *   <li><b>L15-5</b>: a fixed-rem skeleton never pushes the page sideways at 320 / 200 %.</li>
 * </ul>
 */

const MEMBER_ID = "bbbbbbbb-0000-4000-8000-00000000000b";
const BASE = `/api/v1/admin/members/${MEMBER_ID}`;
const LONG_EMAIL = "naledi.khumalo-vandermerwe.longaddress@members-of-the-crusaders-r15.review.test";

function detail() {
  return {
    user_id: MEMBER_ID, membership_id: "cccccccc-0000-4000-8000-00000000000c",
    full_name: "Naledi Khumalo", email: LONG_EMAIL,
    membership_number: "CR-2026-0184", status: "Active", account_status: "Active", email_verified: true,
    created_at: "2026-03-01T08:00:00Z", last_login_at: "2026-09-22T17:30:00Z", photo_url: null,
    is_admin: false, admin_source: null, groups: [],
    balance_minutes: 120, passkey_count: 1, fingerprints: { count: 0, enrolments: [] },
    next_bookings: [], counts_30d: { bookings: 6, no_shows: 1, sessions_played: 5 },
  };
}

function routes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/members/", body: [] },
    { path: BASE, body: detail() },
    { path: `${BASE}/play`, body: { sessions_attended: 0, minutes_this_month: 0, minutes_all_time: 0, current_streak_weeks: 0, matches_played: 0, matches_won: 0, matches_lost: 0, open_disputes: 0, badges_earned: 0 } },
    ...extra,
  ];
}

async function open(page: Page, path: string, width: number, fontPx: number, hang?: string) {
  await page.setViewportSize({ width, height: 900 });
  await signIn(page);
  await serveApi(page, routes());
  // Registered after `serveApi`, so it wins: the read answers late and its skeleton stays up.
  if (hang) await page.route((url) => url.pathname === hang, async (route) => {
    await new Promise((later) => setTimeout(later, 20_000));
    await route.fallback().catch(() => undefined);
  });
  await page.addInitScript((px) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `html { font-size: ${px}px !important; }`;
      document.head.append(style);
    });
  }, fontPx);
  await page.goto(path);
  await expect(page.locator("nav[data-primary-nav]")).toBeVisible({ timeout: 30_000 });
}

/** Sideways scroll on the document or the app's scroller. */
function sideways(page: Page) {
  return page.evaluate(() => Math.max(...[document.documentElement, document.getElementById("main-content")]
    .filter(Boolean).map((el) => el!.scrollWidth - el!.clientWidth)));
}

test.describe("L15-5 — a fixed-rem skeleton stays inside its box", () => {
  test("the member record's loading state does not push a 320 phone sideways at 200 %", async ({ page }) => {
    await open(page, `/admin/members/${MEMBER_ID}`, 320, 32, BASE);
    // The record's own skeleton (its name bar), not the route's while the chunk loads.
    await expect(page.locator("[data-slot='skeleton'].w-40").first()).toBeVisible({ timeout: 30_000 });
    expect(await sideways(page), "sideways scroll while loading").toBeLessThanOrEqual(1);
    const past = await page.locator("[data-slot='skeleton']").evaluateAll((all) => all
      .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.right > document.documentElement.clientWidth + 1).length);
    expect(past, "skeletons past the right edge").toBe(0);
  });
});

test.describe("L15-3 — the member record's terms and values", () => {
  for (const [width, font] of [[1280, 32], [1280, 16], [390, 16]] as const) {
    test(`terms take the longest term's width, beside their values only with room (${width} / ${font}px)`, async ({ page }) => {
      await open(page, `/admin/members/${MEMBER_ID}`, width, font);
      const facts = page.locator("main dl").filter({ has: page.getByText(LONG_EMAIL.slice(0, 12)) });
      await expect(facts).toBeVisible({ timeout: 30_000 });
      const m = await facts.evaluate((dl) => {
        const rows = [...dl.querySelectorAll(":scope > div")].map((row) => {
          const dt = row.querySelector("dt")!;
          const dd = row.querySelector("dd")!;
          const range = document.createRange();
          range.selectNodeContents(dt);
          const words = Math.max(...[...range.getClientRects()].map((r) => r.width));
          return { dt: dt.getBoundingClientRect(), dd: dd.getBoundingClientRect(), words };
        });
        const box = (dl.parentElement as HTMLElement).getBoundingClientRect().width;
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        return {
          room: box / rem >= 30,
          beside: rows.every((r) => Math.abs(r.dd.top - r.dt.top) < 2),
          stacked: rows.every((r) => r.dd.top >= r.dt.bottom - 1),
          termColumn: Math.max(...rows.map((r) => r.dt.width)),
          widestTerm: Math.max(...rows.map((r) => r.words)),
          aligned: new Set(rows.map((r) => Math.round(r.dd.left))).size === 1,
          email: dl.querySelector("dd")!.innerHTML,
        };
      });
      expect(m.email, "the address offers breaks at @ and dots").toContain("<wbr>");
      if (m.room) {
        expect(m.beside, "each value beside its term").toBe(true);
        expect(m.aligned, "every value starts in one column").toBe(true);
        expect(m.termColumn, "the term column is the longest term's width, not a fixed 12rem").toBeLessThanOrEqual(m.widestTerm + 2);
      } else {
        expect(m.stacked, "under the threshold each value sits under its term").toBe(true);
      }
    });
  }
});

test.describe("L15-4 — an alert in a narrow box", () => {
  test("under 14rem the mark stands on its own line and a long first word keeps the full width", async ({ page }) => {
    await serveApi(page, [{ path: "/api/v1/whoami", body: SESSION_ANON }, { path: "/api/v1/session", body: SESSION_ANON }]);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto("/dev/primitives?section=feedback&theme=light");
    await expect(page.locator('[data-gallery-section="feedback"]')).toBeVisible({ timeout: 30_000 });
    const m = await page.locator('[data-gallery-section="feedback"] p.border-l-4').first().evaluate((p) => {
      // The reviewer's box: a 256px callout at 200 % text (an 8rem box), its first word a long name.
      document.documentElement.style.fontSize = "32px";
      const box = document.createElement("div");
      box.style.cssText = "container-type: inline-size; width: 256px";
      p.before(box);
      box.append(p);
      const text = [...p.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!;
      text.textContent = "Bartholomew and Chiamaka get back what they paid for their shares.";
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, "Bartholomew".length);
      const word = [...range.getClientRects()].filter((r) => r.width > 0);
      const mark = p.querySelector("svg")!.getBoundingClientRect();
      return { wordLines: word.length, wordTop: Math.min(...word.map((r) => r.top)), markBottom: mark.bottom };
    });
    expect(m.wordLines, "Bartholomew on one line").toBe(1);
    expect(m.wordTop, "the words start under the mark").toBeGreaterThanOrEqual(m.markBottom - 1);
  });
});

test.describe("L15-1 — a focused row in a clipping list", () => {
  /**
   * `src/clipped-focus-scan.test.ts` holds that every clipping list carries the inset; this holds
   * that the class the lists carry is EMITTED and does what it says in a real browser (the
   * container-queries plugin has emitted nothing for some arbitrary variants before — R12 L12-1).
   */
  test("a list carrying the inset draws a focused row's ring inside the row", async ({ page }) => {
    await open(page, "/admin", 1280, 16);
    await page.evaluate(() => {
      const list = document.createElement("ol");
      list.className = "overflow-hidden rounded-xl border [&_:focus-visible]:-outline-offset-2";
      list.innerHTML = '<li><a id="probe-row" href="#probe" class="block p-3">probe</a></li>';
      document.getElementById("main-content")!.prepend(list);
    });
    await page.keyboard.press("Tab"); // keyboard modality, so a scripted focus is :focus-visible
    const offset = await page.locator("#probe-row").evaluate((link) => {
      link.focus();
      return { visible: link.matches(":focus-visible"), offset: getComputedStyle(link).outlineOffset };
    });
    expect(offset.visible).toBe(true);
    expect(offset.offset).toBe("-2px");
  });
});

/**
 * L15-5 sweep — the reviewer's candidates, each skeleton in its own parent chain (the call sites'
 * class strings, copied), drawn in a 288px box at 200 % text. A fixed `w-40` is 320px there; the
 * primitive's `max-w-full` must hold it inside whatever chain it sits in.
 */
const CHAINS: Record<string, string> = {
  "AdminScheduleDetail header": '<div class="flex flex-col gap-6"><div class="flex flex-col gap-3"><div data-slot="skeleton" class="max-w-full h-5 w-40"></div></div></div>',
  "BookingForBar": '<div class="flex flex-wrap items-start gap-3"><span class="size-6 shrink-0"></span><div class="grid min-w-0 flex-[1_1_14rem] grid-cols-[minmax(0,1fr)] gap-0.5 text-sm"><div data-slot="skeleton" class="max-w-full h-5 w-48"></div><div data-slot="skeleton" class="max-w-full h-4 w-64"></div></div></div>',
  "SheetParts slot line": '<span class="flex min-w-0 flex-1 flex-col gap-1"><div data-slot="skeleton" class="max-w-full mt-1 h-4 w-40 rounded-sm"></div></span>',
  "ScheduleEditor": '<div class="flex flex-col gap-4"><div data-slot="skeleton" class="max-w-full h-touch w-44"></div></div>',
  "ResultCard": '<div class="flex flex-col gap-3 rounded-xl border p-4"><div data-slot="skeleton" class="max-w-full h-touch w-40"></div></div>',
  "FleetShutPanel": '<div class="flex flex-col gap-1.5"><div class="text-sm"><div data-slot="skeleton" class="max-w-full h-4 w-40"></div></div></div>',
  "PasskeyStep": '<div><div data-slot="skeleton" class="max-w-full h-5 w-48"></div></div>',
  "TopUpStatus": '<div class="flex flex-col gap-4 rounded-xl border p-4"><div class="flex items-center justify-between gap-4"><div data-slot="skeleton" class="max-w-full h-10 w-32"></div><div data-slot="skeleton" class="max-w-full h-6 w-24 rounded-full"></div></div><div data-slot="skeleton" class="max-w-full h-touch w-40"></div></div>',
};

test("L15-5 sweep: every candidate's skeleton stays inside a 288px box at 200 % text", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "one width is the measurement");
  await serveApi(page, [{ path: "/api/v1/whoami", body: SESSION_ANON }, { path: "/api/v1/session", body: SESSION_ANON }]);
  await page.goto("/dev/primitives?section=feedback&theme=light");
  await expect(page.locator('[data-gallery-section="feedback"]')).toBeVisible({ timeout: 30_000 });
  const past = await page.evaluate((chains) => {
    document.documentElement.style.fontSize = "32px";
    const out: string[] = [];
    for (const [name, html] of Object.entries(chains)) {
      const box = document.createElement("div");
      box.style.cssText = "width: 288px; overflow: visible";
      box.innerHTML = html;
      document.body.prepend(box);
      const edge = box.getBoundingClientRect().right;
      for (const el of box.querySelectorAll("[data-slot='skeleton']")) {
        const right = el.getBoundingClientRect().right;
        if (right > edge + 1) out.push(`${name}: ${Math.round(right - edge)}px past`);
      }
      box.remove();
    }
    return out;
  }, CHAINS);
  expect(past).toEqual([]);
});
