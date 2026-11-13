import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Question } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { codeUseLine } from "@/lib/myCodeCopy";
import { typography } from "@/lib/typography";
import { CODE_HELP, GUIDE_FROM_CODE, GUIDE_PATH } from "@/lib/onboardingCopy";
import { MEMBER_DOOR_LINK_TAPPABLE } from "../member-door/links";
import { SetupChecklist } from "./SetupChecklist";

/**
 * The "how do I use this" line, the guide and the to-do list, behind one worded button instead of
 * drawn down the page by default. Tapping it opens them, the use line first (BM-13); the page stays
 * the code.
 * The checklist keeps its own rules (active members only, gone once finished or hidden), so a
 * finished member opens a popover of the use line and the guide link alone.
 */
export function CodeHelp({ doors, signedOut }: { doors: boolean; signedOut: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" icon={<Question aria-hidden="true" />} className="shrink-0">
          {CODE_HELP.label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-labelledby="code-help-title" className="flex w-96 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2 id="code-help-title" className={typography({ variant: "h3" })}>{CODE_HELP.heading}</h2>
          <p className="text-sm text-text-secondary">{codeUseLine(doors)}</p>
          <Link to={GUIDE_PATH} className={MEMBER_DOOR_LINK_TAPPABLE}>{GUIDE_FROM_CODE}</Link>
        </div>
        {signedOut ? null : <SetupChecklist />}
      </PopoverContent>
    </Popover>
  );
}
