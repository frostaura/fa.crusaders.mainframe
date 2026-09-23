import { focusHeading } from "@/lib/routeAnnouncer";

/**
 * The first thing in the DOM and the first thing a keyboard reaches (B11, C-L4).
 *
 * <p>
 * It lands on the page's own <code>&lt;h1&gt;</code> — where the route announcer puts focus
 * after a navigation — and on <code>&lt;main&gt;</code> only when a page has not rendered its
 * heading yet. Landing on the heading rather than on the top of <code>&lt;main&gt;</code> is what
 * makes it skip ALL the navigation: the admin console's rail and section switcher live inside
 * <code>&lt;main&gt;</code>, ahead of the page, and a skip link that stopped before them would
 * leave an admin a dozen rail links from the settings they came to change (C14).
 * </p>
 *
 * <p>
 * `sr-only focus:not-sr-only` costs a sighted mouse user nothing until it is focused. The click
 * handler is not decoration: jsdom performs no fragment navigation at all, and a browser only
 * moves focus on a fragment jump when the target is focusable, so doing it here makes the
 * behaviour the same in every engine and testable.
 * </p>
 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      onClick={(event) => {
        event.preventDefault();
        const main = document.getElementById("main-content");
        const heading = main?.querySelector<HTMLElement>("h1");
        if (heading) focusHeading(heading, true);
        else main?.focus();
      }}
      className={[
        "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-skip focus:inline-flex focus:min-h-touch",
        "focus:items-center focus:rounded-lg focus:border focus:border-accent-strong focus:bg-bg-raised focus:px-4",
        "focus:text-sm focus:font-semibold focus:text-accent-strong focus:shadow-md",
      ].join(" ")}
    >
      Skip to main content
    </a>
  );
}
