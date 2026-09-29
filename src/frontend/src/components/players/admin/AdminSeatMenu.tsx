import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShieldCheck } from "@/components/ui/icons";
import type { DetailPlayer } from "@/lib/playersApi";
import { DETAIL_ADMIN } from "@/lib/playersCopy";
import { adminActs, seatName, type AdminAct } from "../detail/detailModel";
import { ACTS } from "./adminActs";

/**
 * God mode on one seat: the acts that mean something on it, in a menu under its chip. Each item
 * opens its own dialog, which asks for the reason and — where money may go below zero — the
 * explicit go-ahead.
 */
export function AdminSeatMenu({ player, onAct }: { player: DetailPlayer; onAct: (act: AdminAct, player: DetailPlayer) => void }) {
  const acts = adminActs(player);
  if (acts.length === 0) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" icon={<ShieldCheck aria-hidden="true" />} aria-label={DETAIL_ADMIN.menu(seatName(player))}>
          {DETAIL_ADMIN.title}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {acts.map((act) => (
          <DropdownMenuItem key={act} onSelect={() => onAct(act, player)}>{ACTS[act].label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
