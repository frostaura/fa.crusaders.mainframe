import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { memberFixture, refuse, renderPage, stubFetch } from "../test/harness";
import { MEMBERS_PAGE } from "../lib/membersCopy";
import { OFFLINE_COPY } from "../lib/offline/offlineCopy";

/**
 * R19 L19-1 (MEDIUM): the Members tab counts are drawn only from a club read WHOLE. The list is
 * walked a page at a time; when page 2 answered 503 the chips kept counting page 1 — "Pending 1"
 * with applications waiting on the page that never arrived — and nothing on screen said so.
 */
afterEach(() => vi.unstubAllGlobals());

const ADA = memberFixture();
const GRACE = memberFixture({
  membership_id: "m2", user_id: "u2", full_name: "Grace Hopper", email: "grace@example.com",
  membership_number: "CR-0002", status: "PendingApproval",
});
const ALAN = memberFixture({
  membership_id: "m3", user_id: "u3", full_name: "Alan Turing", email: "alan@example.com",
  membership_number: "CR-0003", status: "PendingApproval",
});
const JOAN = memberFixture({
  membership_id: "m4", user_id: "u4", full_name: "Joan Clarke", email: "joan@example.com",
  membership_number: "CR-0004", status: "Active",
});

/** The filter chips' own text: label + count. A chip with no count reads its label only. */
function chipTexts(): string[] {
  const group = screen.getByRole("radiogroup", { name: MEMBERS_PAGE.filterLabel });
  return Array.from(group.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim());
}

type Pages = { first: unknown[]; rest: unknown[]; failSecond: () => boolean; third?: unknown[] };

function serve(pages: Pages) {
  return stubFetch([
    {
      path: "/api/v1/admin/members/",
      respond: (req) => {
        if (req.path.includes("cursor=p3")) return { items: pages.third ?? [], next_cursor: null, total: 4 };
        if (req.path.includes("cursor=p2")) {
          if (pages.failSecond()) return refuse(503, { error: "service_busy" });
          return { items: pages.rest, next_cursor: pages.third ? "p3" : null, total: 4 };
        }
        return { items: pages.first, next_cursor: "p2", total: 4 };
      },
    },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
  ]);
}

describe("R19 L19-1 — the Members tab counts come only from a complete read", () => {
  it("draws no count at all when page 2 of the first read answers 503", async () => {
    serve({ first: [ADA, GRACE], rest: [ALAN, JOAN], failSecond: () => true });
    renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members"] });
    await waitFor(() => expect(screen.getByText(MEMBERS_PAGE.loadCaveat, { exact: false })).toBeInTheDocument());
    expect(document.querySelector("[data-pending-count]")).toBeNull();
    for (const text of chipTexts()) expect(text).not.toMatch(/\d/);
  });

  it("draws no count when the LAST of three pages fails (two pages read is still not the club)", async () => {
    const stub = stubFetch([
      {
        path: "/api/v1/admin/members/",
        respond: (req) => {
          if (req.path.includes("cursor=p3")) return refuse(503, { error: "conflict_retry" });
          if (req.path.includes("cursor=p2")) return { items: [ALAN], next_cursor: "p3", total: 4 };
          return { items: [ADA, GRACE], next_cursor: "p2", total: 4 };
        },
      },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ]);
    renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members"] });
    await waitFor(() => expect(stub.calls.some((c) => c.path.includes("cursor=p3"))).toBe(true));
    await waitFor(() => expect(screen.getByText(MEMBERS_PAGE.loadCaveat, { exact: false })).toBeInTheDocument());
    expect(document.querySelector("[data-pending-count]")).toBeNull();
    for (const text of chipTexts()) expect(text).not.toMatch(/\d/);
  });

  it("counts the whole club when every page arrives", async () => {
    serve({ first: [ADA, GRACE], rest: [ALAN, JOAN], failSecond: () => false });
    renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members"] });
    expect(await screen.findByRole("link", { name: "Joan Clarke" })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-pending-count]")?.textContent).toContain("2"));
    expect(chipTexts()[0]).toMatch(/4$/);
  });

  it("a refresh whose page 2 fails keeps the WHOLE club's counts under the stale notice, never page 1's", async () => {
    let failing = false;
    serve({ first: [ADA, GRACE], rest: [ALAN, JOAN], failSecond: () => failing });
    renderPage(<AdminMembersPage />, { initialEntries: ["/admin/members"] });
    expect(await screen.findByRole("link", { name: "Joan Clarke" })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-pending-count]")?.textContent).toContain("2"));

    failing = true;
    fireEvent.click(screen.getByRole("button", { name: MEMBERS_PAGE.refresh }));
    expect(await screen.findByText(OFFLINE_COPY.refreshFailedTitle)).toBeInTheDocument();
    expect(document.querySelector("[data-pending-count]")?.textContent).toContain("2");
    expect(chipTexts()[0]).toMatch(/4$/);
  });
});
