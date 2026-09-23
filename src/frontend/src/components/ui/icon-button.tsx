import type { ComponentProps, ReactNode } from "react";
import { Button, type ButtonProps } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

type IconButtonProps = Omit<ButtonProps, "icon" | "children" | "asChild" | "size" | "aria-label"> & {
  /**
   * What the button does, in words — REQUIRED. It is the accessible name (`aria-label`) and the
   * tooltip, so an icon-only control can never ship unnamed.
   */
  label: string;
  /** The icon (20px by default; the size classes set it). */
  children: ReactNode;
  size?: "icon-sm" | "icon" | "icon-lg";
  /** Where the name appears. The tooltip names the control; it never explains it. */
  tooltipSide?: ComponentProps<typeof TooltipContent>["side"];
};

/**
 * An icon-only button (design-system.md: `label` required → aria-label + tooltip). 44px by
 * default, ghost by default. `pending` swaps the icon for the spinner in place, same as Button.
 */
export function IconButton({
  label, children, size = "icon", variant = "ghost", tooltipSide, ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} size={size} variant={variant} icon={children} {...props} />
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}
