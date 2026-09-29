import { useState } from "react";
import { type AddPlayersAnswer, type BookingDetail, type DetailPlayer } from "@/lib/playersApi";
import { DETAIL_ACTIONS, DETAIL_ADMIN } from "@/lib/playersCopy";
import type { AdminAct } from "../detail/detailModel";
import type { ShareTarget } from "../detail/ShareLinkDialog";
import type { Notice } from "../detail/useOrganiserHands";

/**
 * The admin's god mode on the booking page: which seat act is open, the add, and the link of an
 * open seat the add just made (its token is shown this once, so it is offered at once).
 */
export function useAdminHands(detail: BookingDetail, reload: () => void, say: (notice: Notice) => void) {
  const [acting, setActing] = useState<{ act: AdminAct; player: DetailPlayer } | null>(null);
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  return {
    detail,
    reload,
    say,
    acting,
    act: (act: AdminAct, player: DetailPlayer) => setActing({ act, player }),
    closeAct: () => setActing(null),
    actDone: (notice: Notice) => { setActing(null); say(notice); reload(); },
    adding,
    openAdd: () => setAdding(true),
    closeAdd: () => setAdding(false),
    added: (answer: AddPlayersAnswer, kind: string) => {
      setAdding(false);
      say({ tone: "success", text: DETAIL_ADMIN.added });
      const seat = kind === "link" ? answer.participants.find((p) => p.invite_path) : undefined;
      if (seat) setSharing({ name: DETAIL_ACTIONS.openSeatName, participantId: seat.participant_id, path: seat.invite_path });
      reload();
    },
    sharing,
    closeShare: () => setSharing(null),
  };
}

export type AdminHands = ReturnType<typeof useAdminHands>;

