import { Link } from "react-router-dom";
import { IconButton } from "@/components/ui/icon-button";
import { Question } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { codeUseLine } from "@/lib/myCodeCopy";
import { CODE_HELP, GUIDE_FROM_CODE, GUIDE_PATH } from "@/lib/onboardingCopy";
import { MEMBER_DOOR_LINK_TAPPABLE } from "../member-door/links";
import { SetupChecklist } from "./SetupChecklist";

/**
 * The to-do list, the "how do I use this" line and the guide, behind one help icon instead of
 * drawn down the page by default. Tapping it opens them; the page stays the code.
 * The checklist keeps its own rules (active members only, gone once finished or hidden), so a
 * finished member opens a popover of the use line and the guide link alone.
 */
export function CodeHelp({ doors, signedOut }: { doors: boolean; signedOut: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label={CODE_HELP.label} variant="ghost">
          <Question aria-hidden="true" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-96 flex-col gap-4">
        {signedOut ? null : <SetupChecklist />}
        <p className="text-sm text-text-secondary">{codeUseLine(doors)}</p>
        <Link to={GUIDE_PATH} className={MEMBER_DOOR_LINK_TAPPABLE}>{GUIDE_FROM_CODE}</Link>
      </PopoverContent>
    </Popover>
  );
}
