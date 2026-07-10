import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StepStatus = "idle" | "running" | "done" | "error";

const STATUS_BADGE: Record<StepStatus, { label: string; variant: "secondary" | "warning" | "success" | "destructive" }> = {
  idle: { label: "idle", variant: "secondary" },
  running: { label: "running…", variant: "warning" },
  done: { label: "done", variant: "success" },
  error: { label: "error", variant: "destructive" },
};

export function StepCard({
  index,
  title,
  subtitle,
  status,
  disabled,
  children,
}: {
  index: number;
  title: string;
  subtitle?: string;
  status: StepStatus;
  disabled?: boolean;
  children: ReactNode;
}) {
  const badge = STATUS_BADGE[status];
  return (
    <Card className={cn("transition-opacity", disabled && "opacity-55")}>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold",
              status === "done"
                ? "bg-success/20 text-success"
                : status === "error"
                  ? "bg-destructive/20 text-destructive"
                  : "bg-primary/15 text-primary",
            )}
          >
            {status === "done" ? "✓" : index}
          </div>
          <CardTitle className="text-base">{title}</CardTitle>
          <Badge variant={badge.variant} className="ml-auto">
            {badge.label}
          </Badge>
        </div>
        {subtitle && <p className="pl-10 text-sm text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent className="pl-10">{children}</CardContent>
    </Card>
  );
}

export function KeyVal({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <span className="min-w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {k}
      </span>
      <span className="break-all font-mono text-xs text-foreground">{v}</span>
    </div>
  );
}
