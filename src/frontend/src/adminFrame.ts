/**
 * The admin console's frame and its three doors-store readers, as ONE lazy chunk (perf lane,
 * 2026-09-30).
 *
 * <p>
 * They were eager — ~97 kB of every member's first load (perf report Frontend 3) — because they
 * read the shared doors store, and a reader mounting after a Suspense boundary resolved fired a
 * second `GET /admin/doors` (E-L6). Kept together here so they arrive together; `App.tsx` renders
 * them through `named`, which does not suspend at all once this module is in, so the
 * frame and the page under it mount in one commit; and the doors store no longer re-reads for a
 * reader that joins within moments of a read (`useDoorsChrome`), for a chunk that lands late.
 * </p>
 */
export { default as AdminLayout } from "./components/admin/AdminLayout";
export { default as AdminHomePage } from "./pages/admin/AdminHome";
export { AdminDoorsPage } from "./pages/AdminDoors";
export { AdminDoorsDetailPage } from "./pages/AdminDoorsDetail";
