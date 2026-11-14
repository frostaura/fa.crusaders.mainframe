import { useEffect } from "react";

/**
 * Which page a path is, for the scroll reset (BA-06): a member's record and its tabs are one
 * page with the list beside them (the split view), so moving between them keeps the scroll.
 */
export function scrollPageOf(pathname: string): string {
  return /^\/admin\/members(\/|$)/.test(pathname) ? "/admin/members" : pathname.replace(/\/+$/, "");
}

/**
 * BA-06: `<main>` is the console's scroller and nothing reset it, so a section opened part-way
 * down — Reports with its date filters off-screen, Webhooks with its header hidden. A new page
 * starts at the top; a hash link, and a move inside the members split view, keep their place.
 */
export function useScrollResetOnPage(pathname: string, hash: string): void {
  const page = scrollPageOf(pathname);
  useEffect(() => {
    if (hash) return;
    const main = document.getElementById("main-content");
    if (main) main.scrollTop = 0;
  }, [page, hash]);
}
