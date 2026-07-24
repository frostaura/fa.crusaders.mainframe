import { type HTMLAttributes } from "react";
import { cn } from "../lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bg-bg-surface border border-border rounded-lg shadow-sm p-4 sm:p-6", className)} {...props} />;
}
