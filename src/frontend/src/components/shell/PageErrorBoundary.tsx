import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { WarningCircle } from "@/components/ui/icons";
import { PageShell } from "@/components/ui/page-shell";
import { typography } from "@/lib/typography";

/**
 * A page that throws while rendering takes only itself down, never the shell around it.
 *
 * <p>
 * Without a boundary React unmounts the whole tree, so one bad row on one admin screen left a
 * blank white document: no tab bar, no way to another page, nothing to say what happened. The
 * shell resets it on every path change, so navigating anywhere else clears it; "Reload" is the
 * other way out.
 * </p>
 */
type Props = { children: ReactNode; /** Clears a failure when it changes — the path. */ resetKey: string };

export class PageErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  // A reset key rather than a React `key`: a key would remount every page on every navigation,
  // including a param change a page expects to handle in place.
  componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("A page failed to render", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <PageShell width="narrow">
        <div role="alert" className="flex flex-col items-center gap-4 py-10 text-center">
          <WarningCircle size={48} weight="duotone" aria-hidden="true" className="text-danger-strong" />
          <h1 data-route-heading="" className={typography({ variant: "h1" })}>This page hit a problem</h1>
          <p className="max-w-prose text-sm text-text-secondary">
            Something on this page went wrong while it was being shown. Reload to try again, or use
            the tabs to go somewhere else.
          </p>
          <Button onClick={() => window.location.reload()}>Reload the page</Button>
        </div>
      </PageShell>
    );
  }
}
