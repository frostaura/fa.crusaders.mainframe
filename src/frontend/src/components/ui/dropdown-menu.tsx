import * as React from "react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { CaretRight, Check } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Dropdown menu — Radix, restyled (design-system.md: popover elevation, radius xl, 44px rows).
 *
 * <p>
 * Items are `min-h-touch` rows with the highlight on `bg-bg-muted`; the house `:focus-visible`
 * outline still applies for keyboard users. `no-lift` because a menu item is chosen, not pressed.
 * `variant="danger"` is the only colour an item may take — a destructive row reads in the danger
 * ink, never a raw red.
 * </p>
 */

const DropdownMenu = MenuPrimitive.Root;
const DropdownMenuTrigger = MenuPrimitive.Trigger;
const DropdownMenuGroup = MenuPrimitive.Group;
const DropdownMenuPortal = MenuPrimitive.Portal;
const DropdownMenuSub = MenuPrimitive.Sub;
const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

const PANEL = [
  "z-popover min-w-48 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-bg-raised p-1",
  "text-text-primary shadow-md animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none",
].join(" ");

const ROW = [
  "no-lift relative flex min-h-touch cursor-default select-none items-center gap-2 rounded-lg border border-transparent",
  "px-3 text-sm transition-colors duration-fast ease-standard data-[highlighted]:bg-bg-muted",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 motion-reduce:transition-none",
].join(" ");

function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(PANEL, "origin-[--radix-dropdown-menu-content-transform-origin]", className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

type ItemProps = React.ComponentProps<typeof MenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "danger";
};

function DropdownMenuItem({ className, inset, variant = "default", ...props }: ItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(ROW, inset && "pl-9", variant === "danger" && "text-danger-strong data-[highlighted]:bg-danger-soft", className)}
      {...props}
    />
  );
}

/** The leading slot a checkbox or radio row marks itself in. */
function Indicator({ children }: { children: React.ReactNode }) {
  return <span className="pointer-events-none absolute left-3 flex size-4 items-center justify-center">{children}</span>;
}

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem data-slot="dropdown-menu-checkbox-item" className={cn(ROW, "pl-9", className)} {...props}>
      <Indicator>
        <MenuPrimitive.ItemIndicator>
          <Check size={16} weight="bold" aria-hidden="true" />
        </MenuPrimitive.ItemIndicator>
      </Indicator>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem data-slot="dropdown-menu-radio-item" className={cn(ROW, "pl-9", className)} {...props}>
      <Indicator>
        <MenuPrimitive.ItemIndicator>
          <span className="block size-2 rounded-full bg-current" />
        </MenuPrimitive.ItemIndicator>
      </Indicator>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <MenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-3 py-2 text-xs font-semibold text-text-muted", inset && "pl-9", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="dropdown-menu-shortcut" className={cn("ml-auto text-xs text-text-muted", className)} {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <MenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(ROW, "data-[state=open]:bg-bg-muted", inset && "pl-9", className)}
      {...props}
    >
      {children}
      <CaretRight size={16} className="ml-auto" aria-hidden="true" />
    </MenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        collisionPadding={8}
        className={cn(PANEL, "origin-[--radix-dropdown-menu-content-transform-origin]", className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuRadioGroup,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
