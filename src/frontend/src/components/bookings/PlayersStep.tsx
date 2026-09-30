import { useEffect, useId, useRef } from "react";
import { PlayerPicker } from "@/components/players/PlayerPicker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/icon-button";
import { Export, Plus, User, X } from "@/components/ui/icons";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { BOOK_PLAYERS, PLAYERS_COPY } from "@/lib/playersCopy";
import { BOOK_SEATS } from "@/lib/bookingsCopy";
import { cn } from "@/lib/utils";
import { pickedUserIds, seatName, teamName, type DraftSeat } from "./playersDraft";
import type { PlayersStepState } from "./usePlayersStep";

/**
 * The BookSheet's Players step (D11): "Just me", or up to three others on a court drawn as two
 * sides — yours (seat 1 is you, fixed; seat 2 your partner) and the opponents' (3–4). Tapping an
 * empty seat opens the picker IN PLACE (a panel with Back in the footer, never a dialog inside the
 * sheet); a filled seat has a named × to take them off.
 *
 * <p>
 * <b>Review round 1.</b> Choosing "With other players" only SHOWS the seats — it used to open the
 * picker on seat 2 the moment the radio was reached, so a keyboard arrowing through the choice
 * swapped the whole body and lost its focus (F1.15), and a singles opponent landed on the
 * member's own side (F1.9). Each empty seat says which it is — "Add your partner", "Add an
 * opponent" — and "Just me" shows no seats at all.
 * </p>
 */

export type PlayersStepProps = {
  players: PlayersStepState;
  /** The viewer — left out of the picker, as they already hold seat 1. */
  actorUserId: string | null;
};

export function PlayersStep(props: PlayersStepProps) {
  const { players, actorUserId } = props;
  const headingId = useId();
  const root = useFocusAcrossPicker(players.picking);
  if (players.picking !== null) {
    const exclude = [...(actorUserId ? [actorUserId] : []), ...pickedUserIds(players.draft)];
    return (
      <section ref={root} aria-labelledby={headingId} className="grid gap-3" data-picker-panel="">
        <h3 id={headingId} tabIndex={-1} data-picker-heading="" className="text-base font-semibold text-text-primary">
          {BOOK_SEATS.pickerTitle(players.picking)}
        </h3>
        <PlayerPicker onPick={players.pick} excludeUserIds={exclude} />
      </section>
    );
  }
  return (
    <div ref={root} className="contents">
      <WhoChoice players={players} />
      {players.withOthers ? <Court players={players} /> : null}
    </div>
  );
}

/**
 * R2 F1-9 — the picker swaps the whole step's body, so the focused node vanished twice: opening
 * left focus on the sheet's container, and closing (a pick, or Back) left it there too — or on a
 * footer button that had just been renamed "Cancel". Opening focuses the panel's heading; closing
 * focuses the seat it was opened for: its Remove once filled, its "Add…" button when not.
 */
function useFocusAcrossPicker(picking: number | null) {
  const root = useRef<HTMLDivElement & HTMLElement>(null);
  const last = useRef(picking);
  useEffect(() => {
    const was = last.current;
    last.current = picking;
    if (was === picking) return;
    const box = root.current;
    if (!box) return;
    if (picking !== null) { box.querySelector<HTMLElement>("[data-picker-heading]")?.focus(); return; }
    if (was === null) return;
    const seat = box.querySelector<HTMLElement>(`[data-seat="${was}"]`);
    const target = seat?.tagName === "BUTTON" ? seat : seat?.querySelector<HTMLElement>("button");
    target?.focus();
  }, [picking]);
  return root;
}

function WhoChoice({ players }: { players: PlayersStepState }) {
  const labelId = useId();
  // Selecting never navigates: an arrow key selects as it moves, and the focus must stay here.
  const choose = (value: string) => {
    if (value === "me") players.justMe();
    else players.chooseOthers();
  };
  return (
    <div className="grid gap-3">
      <p id={labelId} className="text-sm font-semibold text-text-primary">{BOOK_PLAYERS.label}</p>
      <RadioGroup value={players.withOthers ? "others" : "me"} onValueChange={choose} aria-labelledby={labelId}>
        <RadioCard value="me" title={BOOK_PLAYERS.justMe} description={BOOK_PLAYERS.justMeHint} />
        <RadioCard value="others" title={BOOK_PLAYERS.withOthers} description={BOOK_SEATS.withOthersHint} />
      </RadioGroup>
    </div>
  );
}

/** The four seats, as two teams. A list per team, so a reader hears "Team A, list, 2 items". */
function Court({ players }: { players: PlayersStepState }) {
  const seatOf = (n: number) => players.draft.seats.find((s) => s.seat === n) ?? null;
  const id = useId();
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-bg-surface p-3" data-court="">
      {[[1, 2], [3, 4]].map((team) => (
        <div key={team[0]} className="grid gap-1.5">
          <p id={`${id}-team-${team[0]}`} className="px-1 text-xs font-semibold uppercase tracking-overline text-text-muted">
            {teamName(team[0])}
          </p>
          <ul aria-labelledby={`${id}-team-${team[0]}`} className="grid gap-1.5">
            {team.map((n) => (
              <li key={n}>
                {n === 1 ? <YouSeat /> : <PartnerSeat seat={n} filled={seatOf(n)} players={players} />}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

const ROW = "flex min-h-touch items-center gap-3 rounded-lg px-2 py-1.5";

function YouSeat() {
  return (
    <div className={cn(ROW, "bg-accent-soft")} data-seat="1">
      <Avatar size={40}>
        <AvatarFallback className="bg-bg-surface"><User size={20} aria-hidden="true" /></AvatarFallback>
      </Avatar>
      <SeatText name={PLAYERS_COPY.you} hint={BOOK_PLAYERS.youHint} />
    </div>
  );
}

function SeatText({ name, hint }: { name: string; hint: string }) {
  return (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="truncate text-sm font-semibold text-text-primary">{name}</span>
      <span className="truncate text-xs text-text-secondary">{hint}</span>
    </span>
  );
}

function hintFor(seat: DraftSeat): string {
  const side = seat.seat <= 2 ? BOOK_SEATS.partner : BOOK_SEATS.opponent;
  if (seat.player.kind === "guest") return `${side} · ${BOOK_PLAYERS.guestHint}`;
  if (seat.player.kind === "link") return `${side} · ${BOOK_PLAYERS.linkHint}`;
  return `${side} · ${BOOK_PLAYERS.memberHint}`;
}

function SeatAvatar({ seat }: { seat: DraftSeat }) {
  const { player } = seat;
  if (player.kind === "link") {
    return (
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-bg-muted text-accent-strong">
        <Export size={20} />
      </span>
    );
  }
  return (
    <Avatar size={40}>
      {player.kind === "member" && player.photoUrl ? <AvatarImage src={player.photoUrl} alt="" /> : null}
      <AvatarFallback name={player.name} />
    </Avatar>
  );
}

function PartnerSeat({ seat, filled, players }: { seat: number; filled: DraftSeat | null; players: PlayersStepState }) {
  if (!filled) {
    return (
      <button
        type="button"
        data-seat={seat}
        aria-label={BOOK_SEATS.addToSeat(seat)}
        onClick={() => players.openPicker(seat)}
        className={cn(
          ROW, "w-full border border-dashed border-control text-left text-accent-strong",
          "transition-colors duration-fast ease-standard motion-reduce:transition-none hover:bg-bg-muted",
        )}
      >
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft">
          <Plus size={20} />
        </span>
        <span className="text-sm font-semibold">{seat <= 2 ? BOOK_SEATS.addPartner : BOOK_SEATS.addOpponent}</span>
      </button>
    );
  }
  const name = seatName(filled.player);
  return (
    <div className={ROW} data-seat={seat}>
      <SeatAvatar seat={filled} />
      <SeatText name={name} hint={hintFor(filled)} />
      <IconButton label={BOOK_PLAYERS.remove(name)} onClick={() => players.remove(seat)}>
        <X aria-hidden="true" />
      </IconButton>
    </div>
  );
}
