import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";
import { BOOKINGS_COPY, UPCOMING } from "../src/lib/bookingsCopy";

/**
 * Review round 2 on the Bookings screen, where only a browser can tell (lane F1): the upcoming
 * cards' avatars and share at twice the text size, the week strip's month caption, forced
 * colours on the day and court chips, and the court chips' touch targets.
 */

const COURTS = ["a", "b", "c", "d", "e"].map((x, i) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}`, slicePriceCredits: 50,
}));

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function wholeDay(date: string) {
  return {
    date, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 0, dayEndMinute: 24 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [],
  };
}

function upcomingGame() {
  const start = `${inDays(1)}T10:30:00Z`;
  return {
    booking_id: "bbbbbbbb-0000-4000-8000-000000000001", court_name: "Court 1", starts_at: start,
    ends_at: `${inDays(1)}T11:00:00Z`, role: "organiser", status: "Confirmed",
    players: [
      { name: "Vera Vermaak", photo_url: null, status: "accepted" },
      { name: "Bruno Castro", photo_url: null, status: "accepted" },
    ],
    my_share_minutes: 1250.5, needs_action: false,
  };
}

async function open(page: Page, date = today()) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
    { path: "/api/v1/schedule", body: wholeDay(date) },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [upcomingGame()] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
  ]);
  await page.goto(date === today() ? "/bookings" : `/bookings?date=${date}`);
  await page.waitForSelector('[role="grid"]');
}

async function atTwiceTheText(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "32px"; });
  });
}

test("F1-8 — the upcoming card's avatars are kept apart by a ring, each face whole", async ({ page }) => {
  await open(page);
  const card = page.locator("[data-upcoming] a").first();
  await expect(card).toBeVisible();
  const faces = await card.locator('[data-slot="avatar"]').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, shadow: getComputedStyle(el).boxShadow };
  }));
  expect(faces).toHaveLength(2);
  // A visible ring: a spread box-shadow of at least 2px.
  for (const f of faces) expect(f.shadow, "ring on each avatar").toMatch(/0px 0px 0px 2px/);
  // The second face never covers the first's initials: at most the ring's width of overlap.
  expect(faces[0].right - faces[1].left, "overlap").toBeLessThanOrEqual(2.5);
});

test("F1-10 — at 200% text on a 390px phone the month caption never breaks inside a word", async ({ page }) => {
  await atTwiceTheText(page);
  // A week that spans two months, so the caption is at its longest.
  const d = new Date();
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  await open(page, lastOfMonth < today() ? today() : lastOfMonth);
  const broken = await page.evaluate(() => {
    const month = document.querySelector<HTMLElement>("[data-week-strip] [data-month]")!;
    const text = month.textContent ?? "";
    // The caption's visible text node, whether it is written straight in or in a shown span.
    const walker = document.createTreeWalker(month, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node && !(node.parentElement?.getClientRects().length && node.textContent?.trim())) node = walker.nextNode();
    if (!node) return { text, out: ["<no visible text>"], overflow: false };
    const out: string[] = [];
    const t = node.textContent ?? "";
    let at = 0;
    for (const word of t.split(" ")) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      if (tops.size > 1) out.push(word);
      at += word.length + 1;
    }
    return { text, out, overflow: month.scrollWidth > month.clientWidth + 1 };
  });
  expect(broken.out, `words broken in "${broken.text}"`).toEqual([]);
  expect(broken.overflow, "caption spills out of its box").toBe(false);
});

test("F1-10 — at 200% text the upcoming card shows the whole share amount", async ({ page }) => {
  await atTwiceTheText(page);
  // R4 form factor (SPEC 3.1): a phone's games strip shows court, time and status only — the money
  // is on the card wherever the games list is 40rem or wider, which at 200 % text is a desktop.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const card = page.locator("[data-upcoming] a").first();
  const share = card.getByText(UPCOMING.share(1250.5), { exact: false });
  await expect(share).toBeVisible();
  const fits = await share.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const box = el.closest("a")!.getBoundingClientRect();
    return { clipped: el.scrollWidth > el.clientWidth + 1, inside: r.right <= box.right + 1 && r.left >= box.left - 1 };
  });
  expect(fits.clipped, "share amount truncated").toBe(false);
  expect(fits.inside, "share amount outside the card").toBe(true);
});

test("F1-11 — forced colours: the selected day, and the current court chip, can be told apart", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ forcedColors: "active" });
  await open(page, inDays(2));
  const look = (sel: string) => page.locator(sel).first().evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.backgroundColor, s.color, s.borderTopColor, s.borderTopWidth, s.outlineStyle, s.outlineColor].join("|");
  });
  const selected = await look('[data-week-strip] [data-state="on"]');
  const plain = await look('[data-week-strip] [data-state="off"]:not([disabled])');
  expect(selected, "selected day looks like any other").not.toBe(plain);
  // …and the difference is the system's own highlight, the one colour the mode keeps for "chosen".
  const highlight = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "Highlight";
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
  expect(selected.split("|")[0], "selected day not in Highlight").toBe(highlight);
  // The past recedes but keeps an edge: dashed, in GrayText — never Highlight.
  const past = page.locator("[data-week-strip] [data-past][disabled]").first();
  if (await past.count()) {
    const edge = await past.evaluate((el) => {
      const s = getComputedStyle(el); return { style: s.borderTopStyle, colour: s.borderTopColor, width: s.borderTopWidth };
    });
    expect(edge.style, "past day has no dashed edge").toBe("dashed");
    expect(edge.width).not.toBe("0px");
    expect(edge.colour, "past day edge invisible").not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(await past.evaluate((el) => getComputedStyle(el).backgroundColor), "past day in Highlight").not.toBe(highlight);
  }
  const chips = page.getByRole("group", { name: BOOKINGS_COPY.courtChips });
  await expect(chips).toBeVisible();
  const on = await chips.locator('[aria-pressed="true"]').evaluate((el) => {
    const s = getComputedStyle(el); return [s.backgroundColor, s.color, s.borderTopColor].join("|");
  });
  const off = await chips.locator('[aria-pressed="false"]').first().evaluate((el) => {
    const s = getComputedStyle(el); return [s.backgroundColor, s.color, s.borderTopColor].join("|");
  });
  expect(on, "current court chip looks like the others").not.toBe(off);
  expect(on.split("|")[0], "current court chip not in Highlight").toBe(highlight);
  await page.screenshot({ path: test.info().outputPath("forced-colours.png") });
});

test("F1-12 — the court chips are 44px touch targets on a 390px phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, inDays(2));
  const chips = page.getByRole("group", { name: BOOKINGS_COPY.courtChips }).getByRole("button");
  await expect(chips.first()).toBeVisible();
  const heights = await chips.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
});
