import { useAuth } from "./lib/useAuth";
import { useDataOwner } from "./lib/offline/useCachedRead";
import { DemoModeMenu } from "./components/demo/DemoModeMenu";
import { DemoStripe } from "./components/demo/DemoStripe";

/**
 * The demo club's chrome — the stripe under the app bar and the account menu's Live / Demo choice —
 * as ONE lazy chunk, loaded only for admins (only admins can be in the demo). It stays out of every
 * member's first load (the entry is at its 500 kB cap) and out of a member's install set
 * (`vite.config.ts` `DESK_PAGES`); it is still precached with the desk's pages afterwards. One
 * default export, so the entry carries one loader for both parts (`components/shell/demoChrome`).
 *
 * <p>
 * The member view (an admin's persona in the demo — not an admin, so `whoami` says it) draws the
 * stripe only: no menu, and no mode read, because that route is the admin's.
 * </p>
 *
 * <p>
 * Whose mode: the confirmed admin's, else (the stripe only, while the club cannot confirm the
 * session) the member this device last confirmed — the shell draws the admin's chrome for them too.
 * </p>
 */
export default function DemoPart({ part, memberView }: { part: "stripe" | "menu"; memberView?: boolean }) {
  const auth = useAuth();
  const owner = useDataOwner().who;
  const confirmed = auth.status === "authenticated" ? auth.userId : null;
  if (part === "menu") return <DemoModeMenu userId={confirmed} />;
  return <DemoStripe userId={confirmed ?? owner} memberView={memberView === true} />;
}
