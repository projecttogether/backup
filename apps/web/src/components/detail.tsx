import type { ReactNode } from "react";
import { cn } from "@/components/ui/utils";

/** Labelled values in a grid: one column on phones, more on wider screens. */
export function Details({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>{children}</dl>;
}

/** One labelled value of `Details`. */
export function Detail(props: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-w-0 content-start gap-0.5", props.className)}>
      <dt className="text-muted-foreground text-xs">{props.label}</dt>
      <dd className="text-sm break-words">{props.children}</dd>
    </div>
  );
}
