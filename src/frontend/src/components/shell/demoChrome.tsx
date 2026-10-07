import { lazy, Suspense, type ComponentType } from "react";

type Props = { part: "stripe" | "menu"; memberView?: boolean };
const nothing: ComponentType<Props> = () => null;
const Lazy = lazy<ComponentType<Props>>(() => import("@/demoMode").catch(() => ({ default: nothing })));

/**
 * The demo club's chrome (`part`: the stripe under the app bar, or the account menu's Live / Demo
 * choice; `memberView`: the session is an admin's member-view persona, which has the stripe and
 * no menu) — the lazy default of ONE admin-only chunk (`src/demoMode.tsx`), so the entry carries a
 * single loader and nothing else; the parts read the session themselves. A chunk that cannot arrive
 * draws nothing rather than taking the app bar down: the shell has no error boundary above the header.
 */
export function DemoPart({ part, memberView }: Props) {
  return <Suspense fallback={null}><Lazy part={part} memberView={memberView} /></Suspense>;
}
