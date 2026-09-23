import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { SETTINGS_COPY } from "@/lib/settingsCopy";

/**
 * "You have unsaved changes" — when the tab closes, and when an in-app link would leave the page.
 *
 * <p>
 * <b>Two guards, because there are two ways out.</b> Closing or reloading the tab is the browser's
 * `beforeunload`, which only lets a page ask, not say what; the browser's own words are all there
 * is. Following a link inside the app is ours to catch, and it deserves a real question naming how
 * much would be lost.
 * </p>
 *
 * <p>
 * <b>Why a capturing click listener rather than `useBlocker`.</b> The app runs under
 * `BrowserRouter`, and react-router's blocker exists only under a data router — moving the whole
 * app to one is not this page's call. A click on a same-origin link to a different path is caught
 * on the way DOWN (capture phase, on `document`, before react-router's own handler on the root),
 * held, and replayed with `navigate` once the admin says to leave. A modified click (new tab), a
 * download, an external link and an in-page `#` link go through untouched. The browser's Back
 * button is not a click and is not caught; `beforeunload` covers leaving the app.
 * </p>
 */
export function LeaveGuard({ changes }: { changes: number }) {
  const navigate = useNavigate();
  const [target, setTarget] = useState<string | null>(null);
  const dirty = changes > 0;

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      const to = interceptedPath(event);
      if (to === null) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(to);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => { if (!open) setTarget(null); }}
      title={SETTINGS_COPY.leaveTitle}
      description={SETTINGS_COPY.leaveBody(changes)}
      confirmLabel={SETTINGS_COPY.leaveConfirm}
      cancelLabel={SETTINGS_COPY.keepEditing}
      onConfirm={() => {
        const to = target;
        setTarget(null);
        if (to !== null) navigate(to);
      }}
    />
  );
}

/** The in-app path a click would navigate to, when it is one this guard should hold; else null. */
function interceptedPath(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === window.location.pathname) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
