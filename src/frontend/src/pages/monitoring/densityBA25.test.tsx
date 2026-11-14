import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { MemberNightPage } from "./MemberNight";
import { CHANGE_ROW } from "./AdminChangeRecord";
import { renderPage, signIn, signOut, stubFetch } from "../../test/harness";
import { NIGHT_TAB_COPY } from "../../lib/memberDetailCopy";

/**
 * BA-25 ("every form factor uses its space"): the Night picker sat in a centred 580px column of a
 * 1180px desktop, and each change-record row was a 130px card for one line.
 */
afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("the Night picker", () => {
  it("is on the full admin frame, with the picker and its privacy notice side by side from lg", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/members", body: [] },
    ]);
    renderPage(<MemberNightPage />, { initialEntries: ["/admin/monitoring/night"] });
    await screen.findByRole("heading", { name: NIGHT_TAB_COPY.pickerTitle });
    expect(document.querySelector("[data-page-shell]")).toHaveAttribute("data-page-shell", "full");
    expect(document.querySelector("[data-night-picker]")).toHaveClass("lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]");
  });
});

describe("a change-record row", () => {
  it("is one dense line in a list 48rem or wider, and a stacked card below it", () => {
    for (const cls of ["@[48rem]/changes:flex-row", "@[48rem]/changes:py-2", "@[48rem]/changes:shadow-none", "flex-col", "@[12rem]/changes:p-4"]) {
      expect(CHANGE_ROW.split(" ")).toContain(cls);
    }
  });
});
