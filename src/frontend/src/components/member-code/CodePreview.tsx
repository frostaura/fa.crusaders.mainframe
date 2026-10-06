import { QrSvg } from "@/components/member-door/QrSvg";
import { useMemberCode } from "@/lib/memberCode/useMemberCode";
import { MY_CODE } from "@/lib/myCodeCopy";
import { CodeGroups, StepCountdown } from "./MemberCodePass";

/**
 * A small, live copy of the member's code for the welcome wizard's "Your one code" step — the
 * `preview` slot `CodeStep` was built with.
 *
 * <p>
 * The same hook as My Code, so opening the wizard enrols the phone exactly as a first visit to My
 * Code would, and what the member sees here is the code the door will take. It is a PREVIEW: the
 * symbol is small and not a button, and the step's link to My Code is where it is held up to a
 * scanner. It says nothing when there is nothing to show — the step's own sentences already say
 * what the code is for — except that a first set-up needs signal, which is worth knowing here.
 * </p>
 */
export function CodePreview() {
  const view = useMemberCode();
  const token = view.code?.token ?? null;
  if (view.phase === "needs-signal") {
    return <p className="text-sm text-text-secondary">{MY_CODE.needsSignal.body}</p>;
  }
  if (view.phase !== "ready" && view.phase !== "loading") return null;
  if (!token) return <p role="status" className="text-sm text-text-secondary">{MY_CODE.loading}</p>;
  return (
    <div data-code-preview="" className="flex items-center gap-4 self-start rounded-xl border border-border bg-bg-raised p-3">
      {/* Paper white under the symbol whatever the theme — a scanner-shaped thing should look like one. */}
      <div aria-hidden="true" className="w-24 shrink-0 overflow-hidden rounded-md">
        <QrSvg value={token} className="block h-auto w-full" />
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-sm text-text-secondary">
        <span aria-label={MY_CODE.codeLabel} className="sr-only">
          <CodeGroups token={token} />
        </span>
        <StepCountdown remainingMs={view.remainingMs} size={24} />
      </div>
    </div>
  );
}
