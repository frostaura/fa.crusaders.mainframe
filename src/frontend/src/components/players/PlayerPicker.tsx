import { useLayoutEffect, useMemo, useRef } from "react";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { TOP_ANCHORED_SHEET } from "@/components/ui/dialog-shape";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PublicMember } from "@/lib/playersApi";
import { PICKER } from "@/lib/playersCopy";
import { FavouritesTab, MembersTab, RecentTab } from "./picker/MemberTabs";
import { GuestTab, LinkTab } from "./picker/OtherTabs";
import { useFavourites, useRecent } from "./picker/usePickerReads";
import { usePickerTab } from "./picker/usePickerTab";

/**
 * P11 — the player picker: Favourites · Recent · Members · Link · Guest (D11–D13).
 *
 * <p>
 * <b>Two shapes, one body.</b> `PlayerPicker` is a panel for a sheet that is already open (the
 * BookSheet's Players step shows it in place, with Back — never a dialog inside a dialog);
 * `PlayerPickerDialog` is the same panel in its own dialog, with the ×, for a page that has no
 * sheet open (the booking's own page: "Invite a player").
 * </p>
 *
 * <p>
 * <b>The picker seats nobody.</b> It hands back one `PickedPlayer` per pick and the caller
 * decides what that means — a seat in a draft, or an add request. Members already on the booking
 * (and the viewer) are shown as "Added" rather than hidden, so a member looking for Sam finds
 * Sam and learns why they cannot pick him twice.
 * </p>
 *
 * <p>
 * <b>Underline tabs, short names</b>, so all five fit a 360px phone without scrolling. Favourites
 * are read once for the whole picker: the star beside a member in Recent or Members is the same
 * star, and starring there puts them in Favourites at once.
 * </p>
 */

/** What the picker hands back: one player to seat. */
export type PickedPlayer =
  | { kind: "member"; userId: string; name: string; photoUrl: string | null }
  | { kind: "guest"; name: string }
  | { kind: "link" };

export type PlayerPickerProps = {
  /** Called once per pick. The picker does not seat anyone itself. */
  onPick: (player: PickedPlayer) => void;
  /** Members already on the booking (and the viewer) — shown as already added, never pickable. */
  excludeUserIds: readonly string[];
  /** Hide the Guest tab (e.g. where guests are not offered). Default true. */
  allowGuest?: boolean;
  /** Hide the Share link tab. Default true. */
  allowLink?: boolean;
};

/**
 * D12 — every tab's panel is at least this tall, so switching Favourites → Link → Guest does not
 * resize the sheet around it; a centred dialog that changed height moved both its edges, and the
 * whole sheet jumped under the member's finger. Longer lists still grow, and the sheet scrolls.
 */
const PANEL = "min-h-80";

/** The picker as a panel, to sit inside a sheet that is already open (the BookSheet's Players step). */
export function PlayerPicker(props: PlayerPickerProps) {
  const { onPick, excludeUserIds, allowGuest = true, allowLink = true } = props;
  const favourites = useFavourites();
  // Read here, not in the tab, so the picker can open on Recent when Favourites is empty (R1 F1.21).
  const recent = useRecent();
  const tab = usePickerTab(favourites.state, recent.state);
  const list = useFollowSelectedTab(tab.value);
  const excludedKey = excludeUserIds.join(",");
  const excluded = useMemo(() => new Set(excludedKey ? excludedKey.split(",") : []), [excludedKey]);
  const pickMember = (m: PublicMember) => onPick({ kind: "member", userId: m.user_id, name: m.name, photoUrl: m.photo_url });
  const tabProps = { favourites, excluded, onPick: pickMember };
  return (
    <Tabs variant="underline" value={tab.value} onValueChange={tab.choose} data-player-picker="">
      <TabsList ref={list} aria-label={PICKER.tabsLabel}>
        <TabsTrigger value="favourites">{PICKER.favourites}</TabsTrigger>
        <TabsTrigger value="recent">{PICKER.recent}</TabsTrigger>
        <TabsTrigger value="members">{PICKER.members}</TabsTrigger>
        {allowLink ? <TabsTrigger value="link">{PICKER.link}</TabsTrigger> : null}
        {allowGuest ? <TabsTrigger value="guest">{PICKER.guest}</TabsTrigger> : null}
      </TabsList>
      <TabsContent value="favourites" className={PANEL}><FavouritesTab {...tabProps} /></TabsContent>
      <TabsContent value="recent" className={PANEL}><RecentTab {...tabProps} recent={recent} /></TabsContent>
      <TabsContent value="members" className={PANEL}><MembersTab {...tabProps} /></TabsContent>
      {allowLink ? <TabsContent value="link" className={PANEL}><LinkTab onPick={() => onPick({ kind: "link" })} /></TabsContent> : null}
      {allowGuest ? (
        <TabsContent value="guest" className={PANEL}><GuestTab onPick={(name) => onPick({ kind: "guest", name })} /></TabsContent>
      ) : null}
    </Tabs>
  );
}

/**
 * R2 F2-13 — the picker opens on Favourites and may then settle on Members once the reads land
 * (R1 F1.21). The dialog's first focus had already gone to the Favourites trigger, so a keyboard
 * or screen-reader user sat on a tab that was not the selected one. When the selection moves and
 * focus is on one of this list's triggers, it follows to the selected trigger. A tab the member
 * chose themselves already holds focus, so this changes nothing for them.
 */
function useFollowSelectedTab(value: string) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = list.current;
    const active = document.activeElement;
    if (!root || !(active instanceof HTMLElement) || !root.contains(active)) return;
    const selected = root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (selected && selected !== active) selected.focus({ preventScroll: true });
  }, [value]);
  return list;
}

export type PlayerPickerDialogProps = PlayerPickerProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dialog's title — "Invite a player". */
  title: string;
};

/**
 * R18 (L17-6) — a pick refused while the picker was still closing (the add answers in ~60ms, the
 * close animation ends ~300ms in) has already taken focus to the page's refusal; returning focus to
 * Invite then took it away again. Focus that already sits on a notice outside the picker stays.
 */
function keepRefusalFocus(event: Event) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest("[data-detail-notice]")) event.preventDefault();
}

/** The same picker in its own dialog (with the ×), for a page that has no sheet open. */
export function PlayerPickerDialog(props: PlayerPickerDialogProps) {
  const { open, onOpenChange, title, ...picker } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-dialog="player-picker" className={TOP_ANCHORED_SHEET} onCloseAutoFocus={keepRefusalFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{PICKER.dialogDescription}</DialogDescription>
        </DialogHeader>
        <DialogBody className="pb-6">
          {open ? <PlayerPicker {...picker} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
