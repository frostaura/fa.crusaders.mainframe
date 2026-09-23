/**
 * The route element every page renders inside — now the P2 app shell.
 *
 * <p>
 * Kept as a module so the route table and every test that mounts `<Layout />` keep one stable
 * import while the shell itself lives in `components/shell/` (top bar, primary nav / bottom tab
 * bar, credits chip, account menu). The gear menu is gone (R16); its admin destinations are
 * under the Admin tab. The attention wording moved to `lib/adminAttention.ts` with the counts.
 * </p>
 */
export { default } from "./shell/AppShell";
export { monitoringAttentionLabel, pendingApplicationsLabel } from "../lib/adminAttention";
