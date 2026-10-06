import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { MagnifyingGlass } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Command — cmdk, restyled to our vocabulary. The engine under the member combobox.
 *
 * <p>
 * Options are `min-h-touch` rows highlighted on `bg-bg-muted` (cmdk marks the active one with
 * `data-selected="true"` and `aria-selected`, which the forced-colours rule in `index.css` picks
 * up). The input is 16px so iOS does not zoom the page when it takes focus.
 * </p>
 */

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      // R17 L17-3 — the root clips (rounded popover corners), and its top edge cut the input's ring
      // by 4px in every member combobox. Rings inside are drawn inset; nothing in a command list is
      // a filled button whose own fill would swallow an inset ring (options are highlighted, not focused).
      className={cn("flex h-full w-full flex-col overflow-hidden bg-bg-raised text-text-primary [&_:focus-visible]:-outline-offset-2", className)}
      {...props}
    />
  );
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="flex items-center gap-2 border-b border-border px-3">
      <MagnifyingGlass size="1rem" aria-hidden="true" className="shrink-0 text-text-muted" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          // `-mx-1 px-1`: the inset ring (see Command) keeps clear of the first letter.
          "-mx-1 flex h-touch w-full bg-transparent px-1 text-base text-text-primary placeholder:text-text-muted",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-72 overflow-y-auto overflow-x-hidden overscroll-contain p-1", className)}
      {...props}
    />
  );
}

function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("px-3 py-6 text-center text-sm text-text-secondary", className)}
      {...props}
    />
  );
}

function CommandLoading({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Loading>) {
  return <CommandPrimitive.Loading data-slot="command-loading" className={cn("p-1", className)} {...props} />;
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-text-primary",
        "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs",
        "[&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-text-muted",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator data-slot="command-separator" className={cn("-mx-1 h-px bg-border", className)} {...props} />;
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "no-lift relative flex min-h-touch cursor-default select-none items-center gap-3 rounded-lg border border-transparent",
        "px-3 py-1.5 text-sm data-[selected=true]:bg-bg-muted",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="command-shortcut" className={cn("ml-auto text-xs text-text-muted", className)} {...props} />;
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandLoading,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
};
