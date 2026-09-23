/**
 * The design-system gallery, on a real page, in a real engine — <b>development only</b>.
 *
 * <p>
 * <b>Why this exists.</b> Much of what the primitives promise can only be answered by a layout
 * engine: a pending button that does not change width, a 44px target at a 32px root font, a
 * segmented thumb measured from its buttons, a watermark cropped by its host, contrast in the dark
 * theme. jsdom reports every offset as 0 and paints nothing, so none of that is testable in the
 * unit runner. `e2e/gallery.spec.ts` runs axe over every section here in both themes and in
 * forced colours; `e2e/segmented-tabs.spec.ts` measures the legacy tabs section.
 * </p>
 *
 * <p>
 * <b>It is not in the production bundle.</b> `App.tsx` reaches this module through a dynamic
 * import inside an `import.meta.env.DEV` branch, which Vite folds to `false` at build time, so the
 * route is dropped and the chunk is never referenced. The Playwright suite runs against
 * `npm run dev`, which is where it does exist.
 * </p>
 *
 * <p>
 * No auth guard, deliberately: it reads nothing, writes nothing, and asks the API for nothing.
 * The gallery itself lives in `pages/dev/` (one file per section); this module is the stable
 * entry `App.tsx` lazy-loads.
 * </p>
 */
export { default } from "./dev/Gallery";
