import { ShutDoorsBanner } from "../doors/ShutDoorsBanner";
import { useDoorsChrome } from "../doors/useDoorsChrome";

/**
 * The club-wide shut banner, as the app shell's ONE lazy admin part (go-live FM-6).
 *
 * <p>
 * The shell drew it from a static `useDoorsChrome` + `ShutDoorsBanner`, which put the doors store,
 * `doorsCopy`, `gateCopy`, `deviceActivity`, `deviceLiveness` and their settings reader — about
 * 30 kB of minified code no member ever runs — into every member's first load, and took the entry
 * past its 500 kB budget. It is only ever mounted for a confirmed admin, so the chunk is fetched
 * for an admin only. It reads the same doors store the admin frame and the doors pages read, which
 * dedupes a read under two seconds old, so mounting it after a Suspense boundary costs no second
 * `GET /admin/doors`.
 * </p>
 */
export default function AdminDoorsBanner({ routeKey }: { routeKey: string }) {
  const doors = useDoorsChrome(true, routeKey);
  return <ShutDoorsBanner chrome={doors} />;
}
