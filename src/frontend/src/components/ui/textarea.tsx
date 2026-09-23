import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { useFieldControl } from "./field";
import { fieldSurface } from "./input";

export function Textarea({ className, rows = 3, ...props }: ComponentProps<"textarea">) {
  const wired = useFieldControl(props);
  return (
    <textarea
      data-slot="textarea"
      rows={rows}
      className={cn(fieldSurface, "flex min-h-24 resize-y px-3 py-2.5 [&[readonly]]:bg-bg-muted", className)}
      {...wired}
    />
  );
}
