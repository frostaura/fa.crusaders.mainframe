import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { scrollPageOf, useScrollResetOnPage } from "./scrollPage";

/** BA-06: a new admin page starts at the top; the members split view and a hash keep their place. */

describe("which page a path is", () => {
  it("treats the members list and any member's record as one page", () => {
    expect(scrollPageOf("/admin/members")).toBe("/admin/members");
    expect(scrollPageOf("/admin/members/u1/wallet")).toBe("/admin/members");
    expect(scrollPageOf("/admin/reports/")).toBe("/admin/reports");
    expect(scrollPageOf("/admin/membership")).toBe("/admin/membership");
  });
});

let go: NavigateFunction = () => undefined;
function Probe() {
  const { pathname, hash } = useLocation();
  go = useNavigate();
  useScrollResetOnPage(pathname, hash);
  return <main id="main-content" />;
}

describe("the scroll reset", () => {
  it("puts a new page at the top and leaves a member's tabs and a hash link alone", () => {
    render(<MemoryRouter initialEntries={["/admin/settings"]}><Probe /></MemoryRouter>);
    const main = document.getElementById("main-content")!;
    main.scrollTop = 683;
    act(() => { go("/admin/reports"); });
    expect(main.scrollTop).toBe(0);
    act(() => { go("/admin/members"); });
    main.scrollTop = 300;
    act(() => { go("/admin/members/u1/wallet"); });
    expect(main.scrollTop).toBe(300);
    act(() => { go("/admin/settings#screens"); });
    expect(main.scrollTop).toBe(300);
  });
});
