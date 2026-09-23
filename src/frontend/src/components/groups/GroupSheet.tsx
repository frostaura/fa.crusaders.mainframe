import { useState, type ReactNode } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Lock } from "../ui/icons";
import {
  Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from "../ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { useIsSmUp } from "../ui/use-media-query";
import type { MemberGroup, MemberGroupBody } from "../../lib/adminApi";
import { GROUP_SHEET, SYSTEM_GROUP } from "../../lib/groupsCopy";
import { GroupEditorSections } from "./GroupEditor";
import { bodyFrom, draftProblems, useGroupDraft, type ClubContext } from "./groupDraft";

export type GroupSheetTab = "settings" | "members";

/**
 * One group, in a sheet: its settings and its members, as two tabs (D2, R21 — "where do admins
 * configure groups, allowed times and pricing"; this is the one place).
 *
 * <p>
 * <b>A sheet, not a card under the list.</b> The editor used to open below every group card, so
 * an admin pressed Edit on the first card and saw nothing change until they scrolled past the
 * rest. A sheet opens where they are looking — from the right on a desktop, full screen on a
 * phone, where the weekly painter needs every pixel — and the list behind it stays put.
 * </p>
 *
 * <p>
 * <b>Save lives in the footer and never scrolls away</b>, and says what it will do ("Create
 * group" / "Save changes"). Problems are shown after the first press, not while the admin is
 * still typing: a sheet that opens with "Give the group a name" under an empty field is telling
 * somebody off for something they have not done yet.
 * </p>
 */
export function GroupSheet(props: {
  group: MemberGroup;
  tab: GroupSheetTab;
  onTab: (tab: GroupSheetTab) => void;
  context: ClubContext;
  saving: boolean;
  error: unknown;
  onSave: (body: MemberGroupBody) => void;
  onClose: () => void;
  members: ReactNode;
}) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { group, tab, onTab, context, saving, error, onSave, onClose } = props;
  const wide = useIsSmUp();
  const creating = group.id === "";
  const { draft, set } = useGroupDraft(group);
  const [pressed, setPressed] = useState(false);

  const save = () => {
    setPressed(true);
    if (Object.keys(draftProblems(draft)).length > 0) return;
    onSave(bodyFrom(draft));
  };

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side={wide ? "right" : "bottom"}
        size={wide ? "auto" : "full"}
        className="sm:max-w-3xl"
        data-sheet="group"
      >
        <SheetHeader>
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle>{creating ? GROUP_SHEET.newTitle : GROUP_SHEET.editTitle(group.name)}</SheetTitle>
            {group.system_key ? (
              <Badge tone="info" icon={<Lock size={14} weight="bold" aria-hidden="true" />}>{SYSTEM_GROUP.badge}</Badge>
            ) : null}
          </div>
          <SheetDescription>{GROUP_SHEET.description}</SheetDescription>
        </SheetHeader>
        <Tabs
          variant="underline"
          value={tab}
          onValueChange={(next) => onTab(next as GroupSheetTab)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="px-4 sm:px-6">
            <TabsList>
              <TabsTrigger value="settings">{GROUP_SHEET.settingsTab}</TabsTrigger>
              <TabsTrigger value="members" disabled={creating}>{GROUP_SHEET.membersTab}</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="settings" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
            <SheetBody className="pt-4">
              <GroupEditorSections draft={draft} set={set} context={context} error={error} showProblems={pressed} />
            </SheetBody>
            <SheetFooter className="border-t border-border pt-4">
              <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button pending={saving} onClick={save}>
                {creating ? GROUP_SHEET.create : GROUP_SHEET.save}
                {creating ? null : <>{" "}<span className="sr-only">{`to ${group.name}`}</span></>}
              </Button>
            </SheetFooter>
          </TabsContent>
          <TabsContent value="members" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
            <SheetBody className="pb-6 pt-4">{creating ? <p className="text-sm text-text-secondary">{GROUP_SHEET.membersAfterCreate}</p> : props.members}</SheetBody>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
