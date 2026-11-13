import { Outlet, useLocation } from "react-router-dom";
import { useScrollResetOnPage } from "../../lib/scrollPage";
import { useAdminAttention } from "@/lib/adminAttention";
import { AdminRail } from "./AdminRail";
import { AdminSectionSwitcher } from "./AdminSectionSwitcher";
import { AdminTour } from "../onboarding/AdminTour";
import { PageNamedByNav, samePath } from "@/components/ui/page-title";
import { ADMIN_NAV_ITEMS } from "./adminNav";

/**
 * The admin console's frame (plan: Target IA → Admin, R16): every `/admin/*` route renders inside it
 * as a nested route's `<Outlet/>`.
 *
 * <ul>
 *   <li><b>xl and up</b> — the grouped left rail (`AdminRail`), sticky, with the three attention
 *   badges (Members = pending, Doors = doors needing attention, Faults = open faults).</li>
 *   <li><b>below xl</b> — the section bar (`AdminSectionSwitcher`) across the top of the page, which
 *   opens the same list in a bottom sheet.</li>
 * </ul>
 *
 * <p>
 * <b>Why the rail waits for `xl` (1280px), not `lg`.</b> A 16rem (ADMIN_RAIL_WIDTH) rail at 1024px leaves a page 704px
 * wide — narrower than a 768px phone-landscape screen without it — and the members table measured
 * exactly that: its name column squeezed to nothing and the Joined column (drawn at 1024 by
 * `e2e/admin-members-layout.spec.ts`) lost. From 1024 to 1279 the section bar costs one row of
 * height instead of a quarter of the width.
 * </p>
 *
 * <p>
 * A page built on `<PageShell>` sets its own width and gutters; a page that is not yet (Members and
 * Settings, rebuilt in P5/P6) gets the same frame here, so it never sits flush against the rail or
 * the glass. The frame stands down by `:has()` for a self-framed child, as the app shell's does. The rail
 * and the bar are both hidden by CSS at the other breakpoint rather than chosen in JavaScript, so
 * the first paint is right at every width and nothing flickers from one shape to the other.
 * </p>
 *
 * <p>
 * Attention is read ONCE here and handed to both; the hook's requests are shared with the app
 * shell's Admin tab badge anyway (see `lib/adminAttention.ts`).
 * </p>
 */
/**
 * The PageShell `full` frame (120rem, `max-w-page`), for a child that does not frame itself (see
 * above). R4 form factor (SPEC 2.1): it was `max-w-wide` (80rem), which left 225px dead on each
 * side of every admin screen at 1920 beside the rail while the app bar ran full-bleed over it; the
 * console's pages are `width="full"` and meet the bar's edge.
 */
const FRAME = [
  "mx-auto flex w-full max-w-page min-h-0 flex-1 flex-col px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8 3xl:px-12",
  "has-[>[data-page-shell]]:max-w-none has-[>[data-page-shell]]:p-0",
  "has-[>[data-full-bleed]]:max-w-none has-[>[data-full-bleed]]:p-0",
].join(" ");

export default function AdminLayout() {
  const { pathname, hash } = useLocation();
  const attention = useAdminAttention();
  useScrollResetOnPage(pathname, hash);
  return (
    // `grow shrink-0`, not `flex-1`: the app shell's frame is a column that may not grow
    // (min-h-0), and `min-h-full` replaces a flex item's content-height floor — so with
    // `flex-1` this box stayed one screen tall while the page overflowed it, and the rail's
    // surface and edge stopped a screen down a long admin page.
    <div data-admin-layout="" className="flex min-h-full w-full shrink-0 grow">
      <AdminRail pathname={pathname} counts={attention} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AdminSectionSwitcher pathname={pathname} attention={attention} />
        <div data-admin-frame="" className={FRAME}>
          {/* The rail (xl) or the section switcher (below) names exactly these pages on screen. */}
          <PageNamedByNav.Provider value={ADMIN_NAV_ITEMS.some((item) => samePath(item.path, pathname))}>
            <Outlet />
          </PageNamedByNav.Provider>
        </div>
      </div>
      {/* P8 — the first-visit tour of the rail / section bar above. Renders nothing once finished. */}
      <AdminTour />
    </div>
  );
}
