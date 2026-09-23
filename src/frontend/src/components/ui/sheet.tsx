import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogSurface,
  DialogTitle,
  type DialogContentProps,
} from "@/components/ui/dialog";

/**
 * A sheet — Radix Dialog anchored to the bottom or the right edge (design-system.md, Components).
 *
 * <p>
 * The same surface as `dialog.tsx` (close ×, typed-text guard, live region, focus trap and
 * restore); only the shape differs. `bottom` is the phone's picker surface; `size="full"` makes it
 * fill the screen for a search list that needs the room (the member combobox on a phone).
 * `right` is a side panel for desktop detail views. No vaul: it is unmaintained, and Radix Dialog
 * already provides everything a sheet needs except a drag gesture.
 * </p>
 */

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

type SheetSide = "bottom" | "right";
type SheetSize = "auto" | "full";

const SIDE: Record<SheetSide, string> = {
  bottom:
    "inset-x-0 bottom-0 rounded-t-2xl pb-[env(safe-area-inset-bottom)] animate-sheet-up data-[state=closed]:animate-sheet-down",
  // No side-slide keyframe exists in the token set yet; the right panel fades like the scrim.
  right:
    "inset-y-0 right-0 h-full w-full max-w-sm border-y-0 border-r-0 animate-overlay-in data-[state=closed]:animate-overlay-out",
};

const SIZE: Record<SheetSide, Record<SheetSize, string>> = {
  bottom: { auto: "max-h-[92dvh]", full: "h-[100dvh] max-h-[100dvh] rounded-t-none" },
  right: { auto: "", full: "max-w-none" },
};

type SheetContentProps = DialogContentProps & { side?: SheetSide; size?: SheetSize };

function SheetContent({ side = "bottom", size = "auto", className, ...props }: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogSurface
        data-slot="sheet-content"
        data-side={side}
        className={cn(SIDE[side], SIZE[side][size], "motion-reduce:animate-none", className)}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}

const SheetHeader = DialogHeader;
const SheetBody = DialogBody;
const SheetFooter = DialogFooter;
const SheetTitle = DialogTitle;
const SheetDescription = DialogDescription;

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
export type { SheetContentProps };
