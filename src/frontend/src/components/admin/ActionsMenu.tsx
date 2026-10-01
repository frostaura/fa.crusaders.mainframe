import { useRef, useState, type ReactNode } from "react";
import { DotsThree } from "../ui/icons";
import { IconButton } from "../ui/icon-button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";

/**
 * A row's or a card's secondary actions behind one ⋯ button (P3: "row actions → dropdown-menu").
 *
 * <p>
 * A row with five worded buttons wraps into a wall at 360px, and every one of them competes with
 * the primary. The primary stays on the row; the rest are here. An item that is consequential
 * carries a `confirm` and opens a {@link ConfirmDialog} — the menu closes first, the dialog opens
 * on its own, and dismissing it puts focus back on this ⋯ button rather than on `<body>`.
 * </p>
 *
 * <p>
 * The trigger is an {@link IconButton}, so its name is also its tooltip — "More actions for
 * Off-peak", never a bare "⋯". Danger items sit last, after a separator, in the danger ink.
 * </p>
 */
export type ActionsMenuItem = {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  /** A plain action: runs on select. */
  onSelect?: () => void;
  /** A consequential one: opens this confirm dialog instead. */
  confirm?: Omit<ConfirmDialogProps, "trigger" | "open" | "onOpenChange" | "returnFocus">;
  disabled?: boolean;
  /**
   * A few words under the label — why a disabled item cannot be pressed (R5 lane G: a config
   * admin's "Remove admin rights"). A disabled item that has one is muted by ink, not by the
   * row's 50 % opacity, so the reason stays readable.
   */
  hint?: string;
};

export function ActionsMenu({ label, items }: { label: string; items: ReadonlyArray<ActionsMenuItem | null | false> }) {
  const trigger = useRef<HTMLButtonElement>(null);
  // Which item's dialog, and whether it is open, are separate: the dialog stays mounted after it
  // closes so its exit animation and its focus return both run.
  const [confirming, setConfirming] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const shown = items.filter((item): item is ActionsMenuItem => Boolean(item));
  const safe = shown.filter((item) => !item.danger);
  const danger = shown.filter((item) => item.danger);
  const active = confirming === null ? null : shown[confirming] ?? null;
  // Nothing to offer, no ⋯ (review round 3, X-2): a built-in group's menu opened empty and
  // unnamed — a control that does nothing is worse than no control.
  if (shown.length === 0) return null;

  const row = (item: ActionsMenuItem) => (
    <DropdownMenuItem
      key={item.label}
      variant={item.danger ? "danger" : "default"}
      disabled={item.disabled}
      className={item.hint ? "py-2 data-[disabled]:opacity-100" : undefined}
      onSelect={() => {
        if (item.confirm) {
          setConfirming(shown.indexOf(item));
          setOpen(true);
        } else item.onSelect?.();
      }}
    >
      {item.icon}
      {item.hint ? (
        <span className="flex min-w-0 flex-col">
          <span className={item.disabled ? "text-text-secondary" : undefined}>{item.label}</span>
          <span className="text-xs text-text-secondary">{item.hint}</span>
        </span>
      ) : item.label}
    </DropdownMenuItem>
  );

  return (
    <>
      {/* Not modal: a modal menu and the dialog it opens both fight over pointer-events on body. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton ref={trigger} label={label}>
            <DotsThree weight="bold" aria-hidden="true" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {safe.map(row)}
          {safe.length > 0 && danger.length > 0 ? <DropdownMenuSeparator /> : null}
          {danger.map(row)}
        </DropdownMenuContent>
      </DropdownMenu>
      {active?.confirm ? (
        <ConfirmDialog
          key={confirming}
          {...active.confirm}
          open={open}
          onOpenChange={setOpen}
          returnFocus={() => trigger.current}
        />
      ) : null}
    </>
  );
}
