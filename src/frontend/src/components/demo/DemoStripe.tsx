import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { ArrowCounterClockwise, Sparkle } from "@/components/ui/icons";
import { DEMO_CODES, DEMO_COPY } from "@/lib/demoModeCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useClubMode } from "./clubMode";
import { AFTER_SWITCH_PATH, leavePage, MODE_SWITCHED_KEY, resetDemoClub, switchClub } from "./switchClub";

/**
 * The stripe under the app bar while an admin is in the demo club — on every route, member pages
 * included, so the demo can never be taken for the live club. It also marks the document
 * (`data-demo-mode` on `<html>`), which gives the app bar its amber top edge (`AppShell`): two
 * cues, one of them colour-free (the words), in both themes.
 *
 * <p>
 * Mounted for every admin (the same lazy chunk as the account menu's mode control), so it is also
 * where this tab hears another tab switch clubs: it then loads afresh, as the switching tab did.
 * </p>
 *
 * <p>
 * <b>The member view</b> (an admin's persona in the demo, `memberView`, told by `whoami`) wears the
 * same stripe — the demo can never be taken for the live club from the member's side either — but
 * says so, has no Reset (that is the admin's, one flip away) and leaves through the member route.
 * Its mode is not read: the persona is not an admin, and the read is the admin's.
 * </p>
 */
export function DemoStripe({ userId, memberView = false }: { userId: string | null; memberView?: boolean }) {
  const mode = useClubMode(memberView ? null : userId);
  const demo = memberView || mode === "demo" || mode === "demo_member";
  useEffect(() => {
    if (!demo) return;
    document.documentElement.setAttribute("data-demo-mode", "");
    return () => document.documentElement.removeAttribute("data-demo-mode");
  }, [demo]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === MODE_SWITCHED_KEY && e.newValue !== null) leavePage.to(AFTER_SWITCH_PATH);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return demo ? <DemoBar memberView={memberView} /> : null;
}

function DemoBar({ memberView }: { memberView: boolean }) {
  /** Set once the club has said yes: the page is leaving, so the button stays busy until it has. */
  const [leaving, setLeaving] = useState(false);
  const from = memberView ? "demo_member" : undefined;
  const back = useAsyncAction(() => switchClub("live", from), {
    success: () => setLeaving(true),
    toast: { action: DEMO_COPY.switchToLiveAction, codes: DEMO_CODES },
  });
  const toAdmin = useAsyncAction(() => switchClub("demo", "demo_member"), {
    success: () => setLeaving(true),
    toast: { action: DEMO_COPY.switchToAdminAction, codes: DEMO_CODES },
  });
  return (
    <div
      role="region"
      aria-label={DEMO_COPY.stripeTitle}
      data-demo-stripe=""
      className="border-t border-warning-strong/30 bg-warning-soft text-warning-strong print:hidden"
    >
      <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 sm:px-6 lg:px-8 3xl:px-12">
        <p className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-sm">
          <Sparkle size={16} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 break-words">
            <strong className="font-semibold">{DEMO_COPY.stripeTitle}</strong> · {memberView ? DEMO_COPY.stripeMemberDetail : DEMO_COPY.stripeDetail}
            <span className="max-sm:sr-only"> — {memberView ? DEMO_COPY.stripeMemberAside : DEMO_COPY.stripeAside}</span>
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {memberView ? (
            <Button size="sm" variant="ghost" pending={toAdmin.pending || leaving} onClick={() => void toAdmin.run()}>
              {DEMO_COPY.backToAdmin}
            </Button>
          ) : (
            <ConfirmDialog
            trigger={<Button size="sm" variant="ghost" icon={<ArrowCounterClockwise aria-hidden="true" />}>{DEMO_COPY.reset}</Button>}
            title={DEMO_COPY.resetTitle}
            description={DEMO_COPY.resetBody}
            confirmLabel={DEMO_COPY.resetConfirm}
            cancelLabel={DEMO_COPY.resetKeep}
            onConfirm={resetDemoClub}
            action={DEMO_COPY.resetAction}
            codes={DEMO_CODES}
            />
          )}
          <Button size="sm" variant="outline" pending={back.pending || leaving} onClick={() => void back.run()}>
            {DEMO_COPY.backToLive}
          </Button>
        </div>
      </div>
    </div>
  );
}
