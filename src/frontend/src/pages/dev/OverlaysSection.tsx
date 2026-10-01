import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { DotsThreeVertical, Gear, PencilSimple, Trash } from "@/components/ui/icons";
import { InfoPopover } from "@/components/ui/info-popover";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Demo, Specimen } from "./parts";

/**
 * The overlays. They portal to `<body>`, so they paint in the PAGE theme — use the theme switch at
 * the top of the gallery to see them dark. One trigger each, not a light/dark pair: a trigger in a
 * dark panel would open a light dialog, which is the wrong lesson.
 */

function DialogDemo() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Open dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust minutes</DialogTitle>
          <DialogDescription>Type a reason, then tap the scrim: the dialog stays open and says why.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field>
            <FieldLabel>Reason</FieldLabel>
            <Input placeholder="Refund for a lights fault" />
            <FieldDescription>Shown on the member ledger.</FieldDescription>
          </Field>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button>Adjust minutes</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SheetDemo({ side }: { side: "bottom" | "right" }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">{side === "bottom" ? "Open bottom sheet" : "Open side sheet"}</Button>
      </SheetTrigger>
      <SheetContent side={side}>
        <SheetHeader>
          <SheetTitle>{side === "bottom" ? "Court 2, 18:00" : "Member detail"}</SheetTitle>
          <SheetDescription>A sheet is a dialog anchored to an edge.</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <p className="text-sm text-text-secondary">The close button, focus trap and typed-text guard are the same as the dialog.</p>
        </SheetBody>
        <SheetFooter>
          <SheetClose asChild>
            <Button variant="outline">Back</Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function PopoverDemo() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Open popover</Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Peak hours">
        <p className="font-semibold text-text-primary">Peak hours</p>
        <p className="mt-1 text-text-secondary">17:00 to 20:00 on weekdays. League members book first.</p>
      </PopoverContent>
    </Popover>
  );
}

function MenuDemo() {
  const [emails, setEmails] = useState(true);
  const [sort, setSort] = useState("name");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Member actions" variant="outline"><DotsThreeVertical /></IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Nomsa Khumalo</DropdownMenuLabel>
        <DropdownMenuItem><PencilSimple size={16} aria-hidden="true" />Edit details</DropdownMenuItem>
        <DropdownMenuItem><Gear size={16} aria-hidden="true" />Settings</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={emails} onCheckedChange={setEmails}>Email receipts</DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
          <DropdownMenuRadioItem value="name">Sort by name</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="balance">Sort by balance</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger"><Trash size={16} aria-hidden="true" />Remove member</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OverlaysSection() {
  return (
    <Demo
      title="Dialog, sheet, popover, tooltip, menu, info"
      note="These portal to the page, so they follow the page theme switch above, not the panels."
    >
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-bg-surface p-4">
        <Specimen label="dialog"><DialogDemo /></Specimen>
        <Specimen label="sheet · bottom"><SheetDemo side="bottom" /></Specimen>
        <Specimen label="sheet · right"><SheetDemo side="right" /></Specimen>
        <Specimen label="popover"><PopoverDemo /></Specimen>
        <Specimen label="tooltip (hover or focus)"><IconButton label="Grid settings" variant="outline"><Gear /></IconButton></Specimen>
        <Specimen label="dropdown menu"><MenuDemo /></Specimen>
        <Specimen label="info popover"><InfoPopover label="Late-cancellation window">Cancel more than 6 hours ahead for a full refund. Inside the window the penalty applies.</InfoPopover></Specimen>
      </div>
    </Demo>
  );
}
