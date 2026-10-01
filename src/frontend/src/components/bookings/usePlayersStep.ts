import { useMemo, useState } from "react";
import type { PickedPlayer } from "@/components/players/PlayerPicker";
import type { SplitMode } from "@/lib/playersApi";
import { confirmPlayersSentence } from "@/lib/playersCopy";
import {
  EMPTY_DRAFT, addPlayer, hasPaying, playersPayload, removeSeat, sentenceSeats, updateSeat, withMode,
  type PlayersDraft,
} from "./playersDraft";
import { distinctPrices, useSplitPreview, type PreviewState } from "./useSplitPreview";
import type { StepId } from "./bookFlow";

/**
 * The BookSheet's players half (D11): the draft, the picker panel's open seat, the live preview
 * and the Confirm sentence. `useBookFlow` composes it; nothing here books anything.
 */

export type PlayersInput = {
  /** A member's sheet. An admin's has no Players step. */
  enabled: boolean;
  /** Every slot's price — the preview is asked once per distinct one. */
  prices: readonly number[];
  step: StepId;
  /** Called on every edit: a different game is a different request (a fresh key, no stale error). */
  onEdit: () => void;
};

export type ConfirmLine = { price: number; sentence: string };

/** The Confirm sentence per distinct price, or null while the server's figures are being read. */
function confirmLines(draft: PlayersDraft, prices: readonly number[], preview: PreviewState, bulk: boolean): ConfirmLine[] | null {
  if (draft.seats.length === 0) return [];
  if (!hasPaying(draft)) {
    return prices.map((price) => ({ price, sentence: confirmPlayersSentence(price, sentenceSeats(draft, []), bulk) }));
  }
  if (preview.status !== "ready") return null;
  return preview.previews.map((p) => ({
    price: p.price_minutes,
    sentence: confirmPlayersSentence(p.price_minutes, sentenceSeats(draft, p.shares), bulk),
  }));
}

export function usePlayersStep(input: PlayersInput) {
  const { enabled, step, onEdit } = input;
  const [draft, setDraftState] = useState<PlayersDraft>(EMPTY_DRAFT);
  const [picking, setPicking] = useState<number | null>(null);
  // "With other players" chosen, before anybody is seated: the seats show, nothing opens (F1.15).
  const [others, setOthers] = useState(false);
  const priceKey = input.prices.join(",");
  const prices = useMemo(() => distinctPrices(priceKey.split(",").map(Number)), [priceKey]);
  const paying = enabled && hasPaying(draft);
  const preview = useSplitPreview(prices, draft, paying && (step === "split" || step === "confirm"));

  const edit = (next: PlayersDraft) => {
    setDraftState(next);
    onEdit();
  };

  const bulk = input.prices.length > 1;
  return {
    draft,
    /** The seats are showing: "With other players" is chosen, or somebody is already seated. */
    withOthers: others || draft.seats.length > 0,
    chooseOthers: () => setOthers(true),
    paying,
    prices,
    bulk,
    picking,
    preview,
    /** The split the phone already knows cannot work — its code, for `playersRefusal`. */
    problem: preview.state.status === "invalid" ? preview.state.error : null,
    payload: enabled ? playersPayload(draft) : null,
    lines: confirmLines(draft, prices, preview.state, bulk),
    openPicker: (seat: number) => setPicking(seat),
    closePicker: () => setPicking(null),
    pick: (player: PickedPlayer) => {
      edit(addPlayer(draft, player, picking ?? undefined));
      setPicking(null);
    },
    remove: (seat: number) => edit(removeSeat(draft, seat)),
    justMe: () => {
      setPicking(null);
      setOthers(false);
      if (draft.seats.length) edit({ ...draft, seats: [] });
    },
    setMode: (mode: SplitMode) => edit(withMode(draft, mode, prices[0] ?? null)),
    setWeight: (seat: number, weight: string) => edit(updateSeat(draft, seat, { weight })),
    setAmount: (seat: number, amount: string) => edit(updateSeat(draft, seat, { amount })),
    setOrganiserWeight: (organiserWeight: string) => edit({ ...draft, organiserWeight }),
  };
}

export type PlayersStepState = ReturnType<typeof usePlayersStep>;

/**
 * What the Split step and its totals actually read — the draft, the batch flag, the preview and
 * the four setters. Narrow on purpose: the booking page's "Change split" dialog supplies exactly
 * this, and a field the BookSheet adds for itself must not become a field every editor owes.
 */
export type SplitEditor = Pick<PlayersStepState, "draft" | "bulk" | "preview" | "setMode" | "setWeight" | "setAmount" | "setOrganiserWeight">;
