import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * The admin Members list, measured rather than argued about.
 *
 * <p>
 * Three rounds once fixed this table without opening it in a browser, and held opposite
 * assertions about the same element; jsdom cannot settle any of it because every rectangle there
 * is zero. Everything below is read out of Chromium.
 * </p>
 *
 * <p>
 * <b>P5 rebuilt the list</b> (one DOM that is a fixed-layout table when its card is at least 48rem
 * wide and a stack of cards below that — every threshold a container query in rem). The
 * invariants this file has paid for are unchanged and all still measured here:
 * </p>
 * <ul>
 *   <li>every row action is inside the scroller's box before anything is scrolled;</li>
 *   <li>no column is drawn underneath another one — read at TWENTY points across each header,
 *   because partial occlusion is the normal case and a centre-point probe once reported a header
 *   8/20 covered as visible;</li>
 *   <li>no balance is ever readable as a smaller number than it is — glyph by glyph, at every pixel
 *   of horizontal scroll — and no balance is ellipsised inside its own column;</li>
 *   <li>every elided cell carries a title that reads it back;</li>
 *   <li>a row's controls sit on ONE line;</li>
 *   <li>the unverified marker is on screen at every width;</li>
 *   <li>the page never scrolls sideways;</li>
 *   <li>all of it against two clubs (the second with a 38-character name, a 34-character membership
 *   number and an eight-digit balance) and at a raised root font, because a layout that only holds
 *   for one club's data, or at 16px, is not a fixed layout.</li>
 * </ul>
 */

type Club = { label: string; longestName: string; longestNumber: string; topBalance: number };

const CLUBS: Club[] = [
  { label: "as seeded", longestName: "Bartholomew Fitzwilliam", longestNumber: "MEM-1006", topBalance: 123456.78 },
  {
    label: "with longer names and bigger numbers",
    longestName: "Wolfgang-Amadeus Buitendach-Oosthuizen",
    longestNumber: "MEM-CRUSADERS-2026-000000000000001",
    topBalance: 98765432.19,
  },
];

const uid = (i: number) => `00000000-0000-0000-0000-00000000020${i}`;

function membersOf(club: Club) {
  return [
    { name: club.longestName, n: club.longestNumber, status: "PendingApproval", verified: false, bal: 0 },
    // Balances of different lengths, one long enough that its clipped prefix is a different
    // plausible amount: `123456.78 cr` cut to `12345` is the exact misread the balance test exists for.
    { name: "Mia van der Merwe", n: "MEM-1005", status: "Active", verified: true, bal: club.topBalance },
    { name: "Sipho Dlamini", n: "MEM-1004", status: "Active", verified: true, bal: 1500 },
    // The negative twin: a minus sign is a glyph like any other, and the widest string a money
    // column has to hold is the negative one.
    { name: "Aisha Patel", n: "MEM-1003", status: "Active", verified: true, bal: club.topBalance === 123456.78 ? -1500 : -club.topBalance },
    { name: "Liam O'Connor", n: "MEM-1002", status: "Suspended", verified: true, bal: 0.5 },
    { name: "Naledi Khoza", n: "MEM-1001", status: "Active", verified: true, bal: 500 },
    { name: "Crusaders Admin", n: "ADMIN-0001", status: "Active", verified: true, bal: 0 },
  ].map((m, i) => ({
    membership_id: `00000000-0000-0000-0000-00000000010${i}`,
    user_id: uid(i),
    email: `${m.n.toLowerCase()}@sample.local`,
    full_name: m.name,
    membership_number: m.n,
    photo_url: null,
    status: m.status,
    member_class: i % 2 === 0 ? "Regular" : "LeagueOrSenior",
    email_verified: m.verified,
    is_admin: i === 6,
    admin_source: i === 6 ? "config" : null,
    created_at: "2026-09-05T08:00:00Z",
    rejection_reason: null,
    balance_credits: m.bal,
  }));
}

async function openMembers(page: import("@playwright/test").Page, club: Club = CLUBS[0]) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/members/", body: membersOf(club) },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/member-groups", body: { groups: [{ id: "g1", name: "League" }, { id: "g2", name: "Social squash" }, { id: "g3", name: "Juniors" }] } },
    { path: "/api/v1/admin/member-groups/g1/members", body: { members: [{ user_id: uid(1) }, { user_id: uid(2) }], cursor: null } },
    { path: "/api/v1/admin/member-groups/g2/members", body: { members: [{ user_id: uid(1) }, { user_id: uid(3) }], cursor: null } },
    { path: "/api/v1/admin/member-groups/g3/members", body: { members: [{ user_id: uid(1) }], cursor: null } },
    {
      path: "/api/v1/me/profile",
      body: { full_name: "Crusaders Admin", email: "any@frostaura.net", photo_url: null, membership_number: "ADMIN-0001", member_class: "Regular" },
    },
  ]);
  await page.goto("/admin/members");
  await expect(page.getByRole("region", { name: "Members table" })).toBeVisible();
  await expect(page.getByText("Naledi Khoza")).toBeVisible();
  // Groups arrive from their own read; measure once the column has settled.
  await expect(page.locator("tbody [data-slot='badge']", { hasText: "Social squash" }).first()).toBeAttached();
}

/** Everything this file asserts, read out of the live layout in one pass. */
async function measure(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Members table"]')!;
    region.scrollLeft = 0;
    const box = region.getBoundingClientRect();
    const controls = Array.from(document.querySelectorAll<HTMLElement>('tbody td[data-label="Actions"] button'));
    const outsideAtRest = controls
      .filter((c) => {
        const r = c.getBoundingClientRect();
        return r.left < box.left - 0.5 || r.right > box.right + 0.5;
      })
      .map((c) => c.getAttribute("aria-label") ?? c.textContent?.trim() ?? "?");
    // Lines of controls in each action cell, grouped by vertical OVERLAP rather than equal tops,
    // because `items-center` centres a 36px button beside a 36px icon button a pixel apart.
    const actionLines = Array.from(document.querySelectorAll("tbody td[data-label='Actions']")).map((cell) => {
      const boxes = Array.from(cell.querySelectorAll<HTMLElement>("button")).map((b) => b.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      let lines = 0;
      let lineBottom = -Infinity;
      for (const b of boxes) {
        if (b.top >= lineBottom - 0.5) { lines += 1; lineBottom = b.bottom; } else lineBottom = Math.min(lineBottom, b.bottom);
      }
      return lines;
    });
    // Every header drawn but sitting under another one — twenty points across each, read off the
    // compositor with elementFromPoint, because occlusion is invisible to a bounding rect.
    const SAMPLES = 20;
    const hiddenColumns = Array.from(document.querySelectorAll<HTMLElement>("thead th"))
      .filter((th) => getComputedStyle(th).display !== "none" && th.getBoundingClientRect().width > 0)
      .map((th) => {
        const r = th.getBoundingClientRect();
        let covered = 0;
        for (let i = 0; i < SAMPLES; i++) {
          const x = r.left + (r.width * (i + 0.5)) / SAMPLES;
          if (x < box.left + 0.5 || x > box.right - 0.5) { covered += 1; continue; }
          const top = document.elementFromPoint(x, r.top + r.height / 2);
          if (!(top === th || th.contains(top))) covered += 1;
        }
        return covered > 0 ? `${th.innerText.trim()} (${covered}/${SAMPLES} covered)` : null;
      })
      .filter((x): x is string => x !== null);
    const drawnColumns = Array.from(document.querySelectorAll<HTMLElement>("thead th"))
      .filter((th) => getComputedStyle(th).display !== "none" && th.getBoundingClientRect().width > 0)
      .map((th) => th.innerText.trim().replace(/\s+/g, " "));
    // Text wider than its own box — the one loss every other probe here is blind to: an
    // ellipsised cell neither overflows the region nor is covered.
    const truncated = Array.from(document.querySelectorAll<HTMLElement>("tbody td"))
      .flatMap((cell) => {
        if (getComputedStyle(cell).display === "none") return [];
        const label = cell.getAttribute("data-label") ?? "Member";
        return Array.from(cell.querySelectorAll<HTMLElement>('[class*="truncate"]')).flatMap((el) => {
          const text = (el.innerText ?? "").trim();
          if (!text || el.scrollWidth <= el.clientWidth + 1) return [];
          return [{ label, text, recoverable: el.title === text }];
        });
      });
    return {
      controls: controls.length,
      table: getComputedStyle(document.querySelector("table")!).display === "table",
      truncated,
      outsideAtRest,
      hiddenColumns,
      drawnColumns,
      maxActionLines: Math.max(0, ...actionLines),
      regionOverflow: region.scrollWidth - region.clientWidth,
      unverifiedMarkers: Array.from(document.querySelectorAll<HTMLElement>('tbody [title^="This member never confirmed"]'))
        .filter((el) => el.getBoundingClientRect().width > 0).length,
      pageScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

/** Every glyph of every balance, at every pixel of horizontal scroll: whole, or not drawn. */
async function partialBalances(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Members table"]') as HTMLElement;
    const max = region.scrollWidth - region.clientWidth;
    const cells = Array.from(document.querySelectorAll<HTMLElement>('tbody td[data-label="Balance"]'));
    const bad: { full: string; seen: string; at: number }[] = [];
    for (let s = 0; s <= max; s += 1) {
      region.scrollLeft = s;
      for (const cell of cells) {
        // Vertically into view (elementFromPoint answers null below the fold), then the box read
        // AFTER that scroll, since moving the page moves the region too.
        cell.scrollIntoView({ block: "center", inline: "nearest" });
        region.scrollLeft = s;
        const box = region.getBoundingClientRect();
        const span = cell.querySelector("span")!;
        const node = span.firstChild!;
        const full = node.textContent!;
        let seen = "";
        for (let i = 0; i < full.length; i++) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + 1);
          const rect = r.getBoundingClientRect();
          if (rect.width === 0) { seen += full[i]; continue; }
          const inBox = rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5;
          const top = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
          const mine = top === span || span.contains(top) || top === cell || cell.contains(top!);
          seen += inBox && mine ? full[i] : "";
        }
        if (seen !== full && seen !== "") bad.push({ full, seen, at: s });
      }
    }
    region.scrollLeft = 0;
    return bad;
  });
}

for (const club of CLUBS) {
  for (const width of [375, 640, 768, 1024, 1440]) {
    test.describe(`the admin members list at ${width}px, ${club.label}`, () => {
      test.use({ viewport: { width, height: 900 } });

      test("keeps every row action on screen, on one line, before anything is scrolled", async ({ page }) => {
        await openMembers(page, club);
        const m = await measure(page);
        // Seven rows: a pending row's Approve + Reject + ⋯, four active rows' Top up + ⋯, and a
        // suspended row's ⋯ — fourteen buttons, every one of them inside the box.
        expect(m.controls).toBe(14);
        expect(m.outsideAtRest, "row actions outside the scroller's box on arrival").toEqual([]);
        expect(m.maxActionLines, "lines of controls in the widest action cell").toBe(1);
      });

      test("draws no column underneath another one, and nothing wider than its card", async ({ page }) => {
        await openMembers(page, club);
        const m = await measure(page);
        expect(m.hiddenColumns, "columns painted over by a pinned column at rest").toEqual([]);
        expect(m.regionOverflow, "table wider than the card it sits in").toBe(0);
        expect(m.pageScrollsSideways, "the page itself scrolls sideways").toBe(false);
      });

      test("never shows a balance as a smaller number than it is, or cuts one off", async ({ page }) => {
        await openMembers(page, club);
        expect((await partialBalances(page)).slice(0, 5), "balances readable as a different amount").toEqual([]);
        const m = await measure(page);
        expect(m.truncated.filter((t) => t.label === "Balance"), "balances ellipsised inside the Balance column").toEqual([]);
      });

      test("gives every elided field a title that reads it back", async ({ page }) => {
        await openMembers(page, club);
        const m = await measure(page);
        expect(m.truncated.filter((t) => !t.recoverable), "elided text with no title to recover it").toEqual([]);
      });

      test("shows the unverified marker for the member it applies to", async ({ page }) => {
        await openMembers(page, club);
        const m = await measure(page);
        expect(m.unverifiedMarkers, "rows carrying the unverified marker").toBe(1);
        await expect(page.getByText("Unverified")).toBeVisible();
      });
    });
  }
}

/**
 * Which shape the list takes, and which columns it draws, at each width — the thresholds are on
 * the CARD (the admin rail takes 16rem from 1280px), so this is where they are proved.
 */
for (const [width, shape] of [
  [375, { table: false, columns: [] }],
  [640, { table: false, columns: [] }],
  [768, { table: false, columns: [] }],
  [1024, { table: true, columns: ["MEMBER", "STATUS", "GROUPS", "BALANCE", "ACTIONS"] }],
  [1280, { table: true, columns: ["MEMBER", "STATUS", "GROUPS", "BALANCE", "ACTIONS"] }],
  [1440, { table: true, columns: ["MEMBER", "STATUS", "GROUPS", "JOINED", "BALANCE", "ACTIONS"] }],
] as const) {
  test.describe(`the members list's shape at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(shape.table ? "is a table with the columns that fit" : "is a stack of cards", async ({ page }) => {
      await openMembers(page);
      const m = await measure(page);
      expect(m.table).toBe(shape.table);
      expect(m.drawnColumns).toEqual(shape.columns);
    });
  });
}

/**
 * The same list with the browser's own font size turned up. Every threshold is in rem, so a
 * raised root font changes WHEN the table appears rather than squeezing Name to nothing — at 24px a
 * 768px screen gets cards. 20px is Chrome's "Large", 24px its "Very large".
 */
for (const rootFont of [20, 24]) {
  for (const width of [640, 768, 1024, 1440]) {
    test.describe(`the admin members list at ${width}px with a ${rootFont}px root font`, () => {
      test.use({ viewport: { width, height: 900 } });

      test("keeps every header clear, every balance whole and every action on one line", async ({ page }) => {
        await openMembers(page, CLUBS[1]);
        await page.addStyleTag({ content: `html { font-size: ${rootFont}px }` });
        const m = await measure(page);
        expect(m.hiddenColumns, "headers painted over at a raised root font").toEqual([]);
        expect(m.regionOverflow, "table wider than the card it sits in").toBe(0);
        expect(m.pageScrollsSideways).toBe(false);
        expect(m.maxActionLines).toBe(1);
        expect(m.truncated.filter((t) => t.label === "Balance"), "balances ellipsised").toEqual([]);
        expect(m.truncated.filter((t) => !t.recoverable), "elided text with no title").toEqual([]);
      });
    });
  }
}

test.describe("opening a member from the list", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("goes to the member from a click anywhere on the row, and stays put for the row's own buttons", async ({ page }) => {
    await openMembers(page);
    const row = page.locator("tbody tr", { hasText: "Sipho Dlamini" });
    await row.getByRole("button", { name: "Top up" }).click();
    await expect(page.getByRole("dialog", { name: "Top up Sipho Dlamini" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/admin\/members$/);

    await row.locator('td[data-label="Status"]').click();
    await expect(page).toHaveURL(new RegExp(`/admin/members/${uid(2)}$`));
  });
});
