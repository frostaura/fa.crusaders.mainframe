import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * The admin Members table, measured rather than argued about.
 *
 * <p>
 * Three rounds fixed this table and none of them opened it in a browser. Round 1 shipped
 * <code>flex-wrap</code> on the row actions, a merge conflict resolution replaced it with
 * <code>flex-row</code> to satisfy a parallel lane's test, and the two lanes then held
 * opposite assertions about the same element with a comment above it that agreed with
 * neither. jsdom cannot settle any of it: every <code>getBoundingClientRect</code> there is
 * zero, which is exactly why the argument survived three rounds.
 * </p>
 *
 * <p>
 * Driven in Chromium against a seeded club, the three candidate layouts measure like this
 * (row height, and how many of a seven-member club's 27 action controls are inside the
 * scroller's box before the admin scrolls anything):
 * </p>
 *
 * <pre>
 *   flex-wrap          768: 92.5-136.5px, 0/27   1440: 92.5-136.5px, 0/27
 *   flex-row           768: 60.5-69px,    0/27   1440: 60.5-69px,    0/27
 *   flex-row + pinned  768: 60.5-69px,   27/27   1440: 60.5-69px,   27/27
 * </pre>
 *
 * <p>
 * So wrapping is what MAKES the tall row — it lets the table squeeze the actions column from
 * 197px to 96px and the buttons stack — and one line alone was never enough, because the
 * whole column started 151px outside the card. Both halves are asserted below, at all three
 * widths, so neither can be undone by the next merge without going red.
 * </p>
 *
 * <p>
 * <b>Two things this file could not see until round 8, and now can.</b>
 * </p>
 *
 * <p>
 * <b>(1) It sampled each header's CENTRE POINT only</b>, so a header half underneath a
 * pinned cell measured as perfectly visible. It was: at 768px the shipped fixture overflowed
 * its container by 61px and 8 of 20 sample points across the <code>CLASS</code> header were
 * painted over by the pinned Balance cell, with this file green. Every header is now read at
 * twenty points across its width and any covered point is a failure.
 * </p>
 *
 * <p>
 * <b>(2) It ran one fixture</b>, whose longest member name is 23 characters — and the
 * previous round's fix was "remove the overflow", which under an <code>auto</code> table
 * layout is a property of the longest string in the club rather than of the CSS. Renaming one
 * member to 25 characters put 80px of overflow and 10 of 20 covered points back. Every layout
 * assertion below therefore runs against two clubs: the one that was seeded, and one with a
 * longer name, a longer membership number and an eight-digit balance. A layout that only
 * holds for one club's data is not a fixed layout, and the point of this file is to say so
 * out loud when that is what it is.
 * </p>
 */

type Club = { label: string; longestName: string; longestNumber: string; topBalance: number };

/**
 * Two clubs, differing only in the three fields that decide column widths.
 *
 * The second one is not a stress test for its own sake: 25 characters is an ordinary South
 * African name ("Christopher van der Merwe"), the membership number is the shape a club that
 * prefixes its year would issue, and an eight-digit balance is what a club buying credit in
 * bulk looks like. If the table can only be laid out for the first of these, it is laid out
 * by luck.
 */
const CLUBS: Club[] = [
  { label: "as seeded", longestName: "Bartholomew Fitzwilliam", longestNumber: "MEM-1006", topBalance: 123456.78 },
  {
    label: "with longer names and bigger numbers",
    longestName: "Wolfgang-Amadeus Buitendach-Oosthuizen",
    longestNumber: "MEM-CRUSADERS-2026-000000000000001",
    topBalance: 98765432.19,
  },
];

function membersOf(club: Club) {
  return [
    { name: club.longestName, n: club.longestNumber, status: "PendingApproval", verified: false, bal: 0 },
    // The balances are deliberately of different lengths, and at least one is long enough that
    // its clipped prefix is a different plausible amount: `123456.78 cr` cut to `12345` is the
    // exact misread this file's third test exists to catch, and a fixture of identical 1500s
    // would have found it at only one scroll offset.
    { name: "Mia van der Merwe", n: "MEM-1005", status: "Active", verified: true, bal: club.topBalance },
    { name: "Sipho Dlamini", n: "MEM-1004", status: "Active", verified: true, bal: 1500 },
    // The negative twin of the club's largest balance, because a minus sign is a glyph like
    // any other and the widest string a money column has to hold is the negative one. Club 1
    // keeps its -1500: varying one field at a time is what makes a fixture tell you anything.
    { name: "Aisha Patel", n: "MEM-1003", status: "Active", verified: true, bal: club.topBalance === 123456.78 ? -1500 : -club.topBalance },
    { name: "Liam O'Connor", n: "MEM-1002", status: "Active", verified: true, bal: 0.5 },
    { name: "Naledi Khoza", n: "MEM-1001", status: "Active", verified: true, bal: 500 },
    { name: "Crusaders Admin", n: "ADMIN-0001", status: "Active", verified: true, bal: 0 },
  ].map((m, i) => ({
    membership_id: `00000000-0000-0000-0000-00000000010${i}`,
    user_id: `00000000-0000-0000-0000-00000000020${i}`,
    email: `${m.n.toLowerCase()}@sample.local`,
    full_name: m.name,
    membership_number: m.n,
    photo_url: null,
    status: m.status,
    member_class: i % 2 === 0 ? "Regular" : "LeagueOrSenior",
    email_verified: m.verified,
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
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Crusaders Admin", email: "any@frostaura.net", photo_url: null,
        membership_number: "ADMIN-0001", member_class: "Regular",
      },
    },
  ]);
  await page.goto("/admin/members");
  await expect(page.getByRole("region", { name: "Members table" })).toBeVisible();
  await expect(page.getByText("Naledi Khoza")).toBeVisible();
}

/** Everything this file asserts, read out of the live layout in one pass. */
async function measure(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Members table"]')!;
    region.scrollLeft = 0;
    const box = region.getBoundingClientRect();
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'tbody td[data-label="Actions"] button, tbody td[data-label="Actions"] a',
      ),
    );
    const outsideAtRest = controls
      .filter((c) => {
        const r = c.getBoundingClientRect();
        return r.left < box.left - 0.5 || r.right > box.right + 0.5;
      })
      .map((c) => c.getAttribute("title") ?? c.textContent?.trim() ?? "?");
    const rowHeights = Array.from(document.querySelectorAll("tbody tr")).map(
      (r) => +r.getBoundingClientRect().height.toFixed(1),
    );
    // How many LINES the controls in a row's action cell occupy. A row-height threshold is a
    // proxy for this and stops being one the moment anything else about the row changes size:
    // giving the actions column a minimum width so the balance pin has a fixed offset to clear
    // meant wrapping went on wrapping while the row only grew from 69px to 96.5px, and the
    // `< 110px` assertion below stopped noticing. This counts the thing itself.
    //
    // Lines are grouped by vertical OVERLAP, not by equal tops. The pending applicant's cell
    // holds two 36px text buttons beside a 32px icon button, and `items-center` centres them —
    // so on one line their tops differ by 2px. Comparing tops calls that two lines and fails a
    // correct layout; two boxes that share vertical extent are on the same line whatever their
    // heights.
    const actionLines = Array.from(document.querySelectorAll("tbody td[data-label='Actions']")).map(
      (cell) => {
        const boxes = Array.from(cell.querySelectorAll<HTMLElement>("button"))
          .map((b) => b.getBoundingClientRect())
          .sort((a, b) => a.top - b.top);
        let lines = 0;
        let lineBottom = -Infinity;
        for (const b of boxes) {
          if (b.top >= lineBottom - 0.5) { lines += 1; lineBottom = b.bottom; }
          else lineBottom = Math.min(lineBottom, b.bottom);
        }
        return lines;
      },
    );
    // Every column that is DRAWN but sits underneath another one at rest — read at TWENTY
    // points across each header, not at its centre.
    //
    // A right-hand `position: sticky` cell is pulled left of its in-flow position by exactly
    // the un-scrolled overflow, and whatever occupied that band is painted over. That is not
    // a bug in the pin; it is the reason column ORDER cannot solve it, because the band is
    // wherever the pins land and every arrangement has a victim.
    //
    // Sampling the centre only is how this file stayed green through a round in which the
    // shipped fixture overflowed by 61px at 768px with 8/20 of the CLASS header covered: the
    // covered band was the header's right-hand half and the centre point sat just clear of it.
    // Partial occlusion is the normal case, not the exotic one — a column is rarely covered
    // exactly across its middle — so a probe that can only see total occlusion is a probe that
    // reports the defect as fixed while an admin cannot read the column.
    //
    // Read off the compositor with elementFromPoint rather than inferred from boxes:
    // occlusion is invisible to a bounding rect, and occlusion is the whole defect.
    const SAMPLES = 20;
    const hiddenColumns = Array.from(document.querySelectorAll<HTMLElement>("thead th"))
      .filter((th) => getComputedStyle(th).display !== "none")
      .map((th) => {
        const r = th.getBoundingClientRect();
        if (r.width === 0) return null;
        let covered = 0;
        for (let i = 0; i < SAMPLES; i++) {
          const x = r.left + (r.width * (i + 0.5)) / SAMPLES;
          if (x < box.left + 0.5 || x > box.right - 0.5) { covered += 1; continue; }
          const top = document.elementFromPoint(x, r.top + r.height / 2);
          if (!(top === th || th.contains(top))) covered += 1;
        }
        const label = th.innerText.trim().replace(/\s+/g, " ");
        return covered > 0 ? `${label} (${covered}/${SAMPLES} points covered)` : null;
      })
      .filter((x): x is string => x !== null);

    // Which columns exist at this width at all, and whether Joined is one of them.
    const drawnColumns = Array.from(document.querySelectorAll<HTMLElement>("thead th"))
      .filter((th) => getComputedStyle(th).display !== "none")
      .map((th) => th.innerText.trim().replace(/\s+/g, " "));

    // TEXT that does not fit its own box, which every other probe in this file is blind to.
    //
    // Region-level clipping and occlusion are what the assertions above measure, and a cell
    // whose content is ellipsised is neither: the region does not overflow, the header is not
    // covered, and the glyph-range walk in the balance test credits a clipped glyph as seen
    // because `Range.getBoundingClientRect` reports layout geometry that `overflow: hidden`
    // never touches, and because the ellipsis itself paints inside the cell. So the round-8
    // fix shipped `98765432.19 cr` rendering as `98765432.1…` at 640, 768, 1024, 1280, 1440
    // AND 1920 with this whole file green, while the comment beside the column claimed 132px
    // held nine significant digits and the column was declared at 126px. A layout gate that
    // cannot see truncated text is the reason that reached an admin.
    //
    // scrollWidth against clientWidth is the direct question — "is this element wider than
    // the box it is drawn in" — and it is the only one of these measurements that survives
    // the content being clipped rather than moved.
    // Every element the table asks to ellipsise — `truncate` is the Tailwind utility that
    // produces this loss and the only thing that can, so the probe looks for the mechanism
    // rather than for a list of columns somebody has to remember to extend.
    const truncated = Array.from(document.querySelectorAll<HTMLElement>("tbody td"))
      .flatMap((cell) => {
        if (getComputedStyle(cell).display === "none") return [];
        const label = cell.getAttribute("data-label") ?? "Name";
        return Array.from(cell.querySelectorAll<HTMLElement>('[class*="truncate"]')).flatMap((el) => {
          const text = (el.innerText ?? "").trim();
          if (!text) return [];
          // 1px of slack: sub-pixel text metrics round scrollWidth up on strings that fit.
          if (el.scrollWidth <= el.clientWidth + 1) return [];
          return [{ label, text, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, recoverable: el.title === text }];
        });
      });

    return {
      controls: controls.length,
      truncated,
      outsideAtRest,
      hiddenColumns,
      drawnColumns,
      maxActionLines: Math.max(0, ...actionLines),
      maxRowHeight: Math.max(...rowHeights),
      regionOverflow: region.scrollWidth - region.clientWidth,
      unverifiedMarkers: document.querySelectorAll('tbody [title^="This member never confirmed"]').length,
      pageScrollsSideways:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

// 640 and 1024 are here because they are where the previous round's table overflowed while
// this file looked only at 768 and 1440: 32px and 9px, with Status and Joined partly under a
// pin. A breakpoint is exactly where a layout is most likely to be wrong and least likely to
// be measured.
for (const club of CLUBS) {
  for (const width of [640, 768, 1024, 1440]) {
    test.describe(`the admin members table at ${width}px, ${club.label}`, () => {
      test.use({ viewport: { width, height: 900 } });

      test("every row action is on screen before the admin scrolls anything", async ({ page }) => {
        await openMembers(page, club);
        const m = await measure(page);

        // 27 for this club: four icons on each of five Active rows, two on the admin's own row
        // pattern, and Approve/Reject/Resend on the pending applicant.
        expect(m.controls).toBeGreaterThanOrEqual(20);
        // The measurement that the whole argument was missing. Unpinned, this list is every
        // control in the table.
        expect(m.outsideAtRest, "row actions outside the scroller's box on arrival").toEqual([]);
      });

      test("draws no column underneath another one", async ({ page }) => {
        await openMembers(page, club);
        const m = await measure(page);

        // This replaced an assertion that the table must be WIDER than its card. That was a
        // guard on the pin doing work, and it was also the defect's home: the un-scrolled
        // overflow is exactly the band the right-hand pins cover, so as long as it existed a
        // whole column sat underneath them.
        expect(m.hiddenColumns, "columns painted over by a pinned column at rest").toEqual([]);

        // And the mechanism, asserted directly rather than only through its symptom. The
        // table is `table-fixed` from `sm` up, so it is exactly its container's width whatever
        // the club is called; overflow is what the pins hide things in, and there is none to
        // hide anything in. Asserting the width rather than the occlusion is what makes this
        // fixture-independent: occlusion needs the covered band to land on a sampled point,
        // and overflow does not.
        expect(m.regionOverflow, "table wider than the card it sits in").toBe(0);
      });

      test("never shows a member's balance as a smaller number than it is", async ({ page }) => {
        await openMembers(page, club);
        const partial = await page.evaluate(() => {
          const region = document.querySelector('[role="region"][aria-label="Members table"]') as HTMLElement;
          const max = region.scrollWidth - region.clientWidth;
          const cells = Array.from(document.querySelectorAll<HTMLElement>('tbody td[data-label="Balance"]'));
          const bad: { full: string; seen: string; at: number }[] = [];
          for (let s = 0; s <= max; s += 1) {
            region.scrollLeft = s;
            const box = region.getBoundingClientRect();
            for (const cell of cells) {
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
                // Inside the scroller's box AND not painted over by a pinned cell. Occlusion is
                // what a bounding box alone cannot see, and occlusion is the whole defect here,
                // so it is read off the compositor with elementFromPoint rather than inferred.
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

        // Every glyph of every balance, at every pixel of horizontal scroll: a balance is either
        // fully legible or not drawn, never a readable prefix of itself. Before the balance
        // column was pinned this list held 222 entries at 1440px, including `123456.78 cr`
        // showing as `12345` at scrollLeft 0 — no scrolling, no ellipsis, no cue, on the screen
        // where an admin adjusts a member's credit. A fixed column clips as silently as a pin
        // covered, which is why the second club here carries an eight-digit balance.
        expect(partial.slice(0, 5), "balances readable as a different amount").toEqual([]);
      });

      /**
       * The check the three tests above are all blind to.
       *
       * <p>
       * Nothing else in this file can see a cell whose text is cut off <em>inside</em> its own
       * box: the region does not overflow, no header is covered, and the balance test's
       * glyph-range walk credits a clipped glyph as seen. Round 8 shipped an eight-digit
       * balance reading as <code>98765432.1…</code> at every width with this file green, on
       * this file's own second fixture.
       * </p>
       *
       * <p>
       * The money column is the one that must never elide, because a balance is the only
       * string here whose prefix is a different, plausible, smaller amount. Everything else
       * may — a fixed column has to take its width from somewhere — but only with the hover
       * title that makes the loss recoverable rather than final.
       * </p>
       */
      test("never cuts a balance off inside its own column", async ({ page }) => {
        await openMembers(page, club);
        const m = await measure(page);

        const balances = m.truncated.filter((t) => t.label === "Balance");
        expect(balances, "balances ellipsised inside the Balance column").toEqual([]);
      });

      test("gives every column it does elide a hover title to read it back", async ({ page }) => {
        await openMembers(page, club);
        const m = await measure(page);

        // A truncated membership number had no title at all until round 9 — 245px of content
        // in an 80px box, cut to `MEM-CRUSA…`, with nothing anywhere on the screen holding the
        // rest of it. An ellipsis with no hover text is a silent loss wearing a cue.
        expect(m.truncated.filter((t) => !t.recoverable), "elided cells with no title to recover them").toEqual([]);
      });

      test("no row is a stack of buttons", async ({ page }) => {
        await openMembers(page, club);
        const m = await measure(page);
        // The assertion that actually discriminates: every control in an action cell shares one
        // painted top, so the four things an admin came here to press sit along the row rather
        // than down it. `flex-col` and `flex-wrap` both break this; a height threshold only
        // catches them while nothing else constrains the column.
        expect(m.maxActionLines, "lines of controls in the widest action cell").toBe(1);
        // Kept as the coarse backstop it always was. Stacked: 164.5px. One line: 69px.
        expect(m.maxRowHeight).toBeLessThan(110);
      });
    });
  }
}

/**
 * The unverified marker, at every width the table is a table at.
 *
 * <p>
 * It used to live inside the Email cell, which is drawn only from 1280px up — so the round
 * that turned the state on made the marker invisible from 640px to 1279px, on the same screen
 * whose job is answering "the app won't let me in". At 1024-1279 it had been drawn and
 * uncovered before that round, so it was information a working console lost. It now rides on
 * Status, which is drawn at every width, and this is the assertion that keeps it there.
 * </p>
 */
for (const width of [375, 640, 768, 1024, 1279, 1280, 1440, 1920]) {
  test.describe(`the unverified marker at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("is on screen for the member it applies to", async ({ page }) => {
      await openMembers(page);
      const m = await measure(page);
      // Exactly one member in the fixture is unverified, and the admin can see which.
      expect(m.unverifiedMarkers, "rows carrying the unverified marker").toBe(1);
      await expect(page.getByText("Unverified")).toBeVisible();
    });
  });
}

// Where `Joined` — the column three rounds argued about — actually appears. Below the width
// at which it fits it is absent rather than drawn under a pin, and the row is a card below
// `sm`, where every field is on screen.
for (const [width, drawn] of [[768, false], [1024, true], [1440, true], [1920, true]] as const) {
  test.describe(`the Joined column at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(drawn ? "is drawn and readable" : "is not drawn at all, rather than drawn and covered", async ({ page }) => {
      await openMembers(page);
      const m = await measure(page);
      expect(m.drawnColumns.includes("Joined")).toBe(drawn);
      // Either way, nothing on screen is hiding behind the pins.
      expect(m.hiddenColumns).toEqual([]);

      if (!drawn) return;
      // Drawn means legible: every glyph of the date inside the scroller's box and topmost.
      const unreadable = await page.evaluate(() => {
        const region = document.querySelector('[role="region"][aria-label="Members table"]') as HTMLElement;
        region.scrollLeft = 0;
        const box = region.getBoundingClientRect();
        return Array.from(document.querySelectorAll<HTMLElement>('tbody td[data-label="Joined"]'))
          .filter((cell) => {
            const node = cell.firstChild;
            if (!node || !node.textContent?.trim()) return false;
            const r = document.createRange();
            r.selectNodeContents(cell);
            const rect = r.getBoundingClientRect();
            const inBox = rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5;
            const top = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
            return !(inBox && (top === cell || cell.contains(top)));
          })
          .map((cell) => cell.innerText.trim());
      });
      expect(unreadable, "join dates drawn outside the box or under a pinned column").toEqual([]);
    });
  });
}

for (const club of CLUBS) {
  test.describe(`the admin members table at 375px, ${club.label}`, () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("becomes cards, and never drags the page sideways", async ({ page }) => {
      await openMembers(page, club);
      const m = await measure(page);
      // Below `sm` every row is a card and each cell prints its own column name, so there is
      // nothing to scroll to and nothing hidden — 0px of overflow, measured. There is no
      // column here to bound a long name or a long membership number, so each of those
      // fields carries its own cap in card mode; the second club is what proves it.
      expect(m.regionOverflow).toBe(0);
      // A horizontally scrolling document is how an admin loses the navigation as well as the
      // column. The table must not be the thing that causes it.
      expect(m.pageScrollsSideways).toBe(false);
    });
  });
}

/**
 * The same table, with the browser's own font size turned up.
 *
 * <p>
 * "Make text bigger" is an ordinary accessibility setting, not an exotic one, and it is the
 * one variation none of this file's fixtures could reach: every club above differs in its
 * DATA, and this differs in the reader. Round 8's verifier found it by hand — at a 24px root
 * font the fixed 104px Member # header's nowrap sort button spilled onto its neighbour and
 * painted over 3 of 20 sample points of the Status header, while <code>regionOverflow</code>
 * stayed 0 and every other assertion in this file stayed green. A fixed-width column cannot
 * grow for its own header, so the header has to give way inside its column instead: it is
 * clipped with an ellipsis and a hover title, which is a cued loss rather than a silent one.
 * </p>
 *
 * <p>
 * The balance column is declared in <code>rem</code> for the same reason and it is the reason
 * this block asserts the truncation check too. Text scales with the root font and a column
 * declared in <code>px</code> does not, so at 20px <code>98765432.19 cr</code> needed 133px of
 * a 113px box and at 24px it needed 160 of 107 — the money column silently elided at exactly
 * the setting a reader turns on because they are finding it hard to read.
 * </p>
 *
 * <p>
 * 24px is the largest of Chrome's five preset font sizes ("Very large"); 20px is "Large".
 * </p>
 */
for (const rootFont of [20, 24]) {
  for (const width of [640, 768, 1024, 1440]) {
    test.describe(`the admin members table at ${width}px with a ${rootFont}px root font`, () => {
      test.use({ viewport: { width, height: 900 } });

      test("keeps every header clear of its neighbours and every balance whole", async ({ page }) => {
        await openMembers(page, CLUBS[1]);
        await page.addStyleTag({ content: `html { font-size: ${rootFont}px }` });
        const m = await measure(page);

        expect(m.hiddenColumns, "headers painted over at a raised root font").toEqual([]);
        expect(m.regionOverflow, "table wider than the card it sits in").toBe(0);
        expect(m.truncated.filter((t) => t.label === "Balance"), "balances ellipsised").toEqual([]);
        expect(m.truncated.filter((t) => !t.recoverable), "elided cells with no title").toEqual([]);
      });
    });
  }
}
