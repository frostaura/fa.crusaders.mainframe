import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * The P4 headed walk's grid findings, in a real browser — what jsdom cannot measure.
 *
 * <ul>
 *   <li><b>The hover checkbox lay on the label</b> ("□ok" where the cell said "Book"). A
 *   checkbox must never overlap a cell's text — at rest, hovered, selected or focused, at
 *   1440 px and 375 px, in both themes.</li>
 *   <li><b>Two courts at one time</b> keep both picks under a real mouse.</li>
 * </ul>
 */

const COURT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const COURT_B = "aaaaaaaa-0000-4000-8000-00000000000b";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Free cells, the viewer's own booking at 07:30 and somebody else's at 08:00 (an admin may take it). */
function day() {
  const d = tomorrow();
  const slot = (court: string, n: number, from: string, to: string, extra: Record<string, unknown>) => ({
    courtId: court, courtNumber: n, startsAtUtc: `${d}T${from}:00.000Z`, endsAtUtc: `${d}T${to}:00.000Z`,
    status: "booked", ownerUserId: null, ownerFirstName: null, ownerPhotoUrl: null, isMine: false,
    blockLabel: null, checkedIn: false, amountChargedMinutes: 50, ...extra,
  });
  return {
    date: d, timezone: "UTC", sliceMinutes: 15,
    dayStartMinute: 7 * 60, dayEndMinute: 9 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [
      { id: COURT_A, courtNumber: 1, name: "Court 1" },
      { id: COURT_B, courtNumber: 2, name: "Court 2" },
    ],
    slots: [
      slot(COURT_A, 1, "07:30", "07:45", { isMine: true, bookingId: "mine-1" }),
      slot(COURT_B, 2, "08:00", "08:15", { ownerUserId: "bbbbbbbb-0000-4000-8000-00000000000b", ownerFirstName: "Thandi", bookingId: "bk-1" }),
    ],
    rules: { clubHours: { start: "07:00", end: "09:00" }, remainingToday: null, adminExempt: true },
  };
}

async function openGrid(page: Page, isAdmin: boolean) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: isAdmin } },
    { path: "/api/v1/schedule", body: day() },
    { path: "/api/v1/admin/members/", body: [] },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
  ]);
  await page.goto(`/bookings?date=${tomorrow()}`);
  await page.waitForSelector('[role="grid"]');
}

type Geometry = { overlap: boolean; opacity: number; check: number[]; label: number[][] };

/**
 * Where a cell's checkbox box is against every piece of its label: each text line (measured by a
 * Range, so it is the ink, not the element) and the avatar. Waits out the fade first.
 */
async function geometry(page: Page, cellName: string): Promise<Geometry> {
  const cell = page.getByRole("gridcell", { name: cellName, exact: true });
  await cell.locator("[data-cell-check]").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return cell.evaluate((el) => {
    const button = el.querySelector("button")!;
    const wrap = button.querySelector<HTMLElement>("[data-cell-check]")!;
    const box = wrap.firstElementChild!.getBoundingClientRect();
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim() || node.parentElement?.closest("[data-cell-check]")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...range.getClientRects());
    }
    for (const avatar of button.querySelectorAll(".ring-2")) rects.push(avatar.getBoundingClientRect());
    const hits = (r: DOMRect) => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
    return {
      overlap: rects.some(hits),
      opacity: Number(getComputedStyle(wrap).opacity),
      check: [box.left, box.top, box.right, box.bottom],
      label: rects.map((r) => [r.left, r.top, r.right, r.bottom]),
    };
  });
}

const FREE = "Court 2 at 07:15";
const MINE = "Court 1 at 07:30";
const THEIRS = "Court 2 at 08:00";

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [1440, 375]) {
    test(`the checkbox never lies on a cell's label — ${width}px, ${colorScheme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await openGrid(page, true);
      const canHover = await page.evaluate(() => matchMedia("(hover: hover)").matches);
      const cells = [FREE, MINE, THEIRS];

      // Hovered (a pointer that can hover only — touch has no hover checkbox).
      if (canHover) {
        for (const name of cells) {
          await page.getByRole("gridcell", { name, exact: true }).locator("button").first().hover();
          const g = await geometry(page, name);
          expect(g.opacity, `${name}: the hover checkbox shows`).toBeGreaterThan(0.9);
          expect(g.overlap, `${name} hovered: ${JSON.stringify(g)}`).toBe(false);
        }
      }

      // Focused from the keyboard, out of selection mode.
      await page.getByRole("gridcell", { name: FREE, exact: true }).locator("button").focus();
      const focused = await geometry(page, FREE);
      expect(focused.overlap && focused.opacity > 0, `focused: ${JSON.stringify(focused)}`).toBe(false);

      // In selection mode, and selected.
      await page.mouse.move(0, 0);
      await page.getByRole("button", { name: "Select several slots" }).click();
      for (const name of cells) {
        const g = await geometry(page, name);
        expect(g.overlap, `${name} in the mode: ${JSON.stringify(g)}`).toBe(false);
        await page.getByRole("gridcell", { name, exact: true }).locator("button").first().click();
        await expect(page.getByRole("gridcell", { name, exact: true })).toHaveAttribute("aria-selected", "true");
        const s = await geometry(page, name);
        expect(s.overlap, `${name} selected: ${JSON.stringify(s)}`).toBe(false);
      }
      await page.screenshot({ path: info.outputPath(`check-${width}-${colorScheme}.png`) });
    });
  }
}

test("two courts at one time keep both picks under a real mouse", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGrid(page, true);
  await page.getByRole("button", { name: "Select several slots" }).click();
  await page.getByRole("button", { name: /^Book Court 1 at 08:45/ }).click();
  await page.getByRole("button", { name: /^Book Court 2 at 08:45/ }).click();
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(2);
  await expect(page.getByRole("toolbar", { name: "Selected slots" })).toContainText("2 slots · 30 min");
});
