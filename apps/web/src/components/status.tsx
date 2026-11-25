import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/components/ui/utils";
import type { RunStatus } from "@backup/shared/api/runs";
import type { SourceKind, SourceStatus } from "@backup/shared/api/sources";
import { defineMessages, useT } from "@/i18n";

export const statusMessages = defineMessages({
  en: {
    ok: "OK",
    warning: "Warning",
    failed: "Failed",
    overdue: "Overdue",
    running: "Running",
    queued: "Waiting",
    queuedAgent: "Waiting for the agent",
    never: "No backup yet",
    paused: "Paused",
    succeeded: "Succeeded",
    cancelled: "Cancelled",
  },
});

export type Tone = "success" | "warning" | "danger" | "muted" | "busy";

const TONES: Record<Exclude<Tone, "danger" | "muted">, string> = {
  success: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  warning: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  busy: "",
};

/** A small colored label: green, amber, red, muted, or with a spinner. */
export function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  if (tone === "danger") return <Badge variant="destructive">{children}</Badge>;
  if (tone === "muted") return <Badge variant="secondary">{children}</Badge>;
  if (tone === "busy")
    return (
      <Badge variant="outline">
        <Spinner aria-hidden className="size-3" />
        {children}
      </Badge>
    );
  return <Badge className={cn(TONES[tone])}>{children}</Badge>;
}

const SOURCE_TONES: Record<SourceStatus, Tone> = {
  ok: "success",
  warning: "warning",
  failed: "danger",
  overdue: "danger",
  running: "busy",
  queued: "muted",
  never: "muted",
  paused: "muted",
};

/** A source's state; app sources wait for their agent rather than the worker. */
export function SourceStatusBadge({ status, kind }: { status: SourceStatus; kind: SourceKind }) {
  const t = useT(statusMessages);
  const label = status === "queued" && kind === "app" ? t("queuedAgent") : t(status);
  return <ToneBadge tone={SOURCE_TONES[status]}>{label}</ToneBadge>;
}

const RUN_TONES: Record<RunStatus, Tone> = {
  queued: "muted",
  running: "busy",
  succeeded: "success",
  warning: "warning",
  failed: "danger",
  cancelled: "muted",
};

/** A run's state; a queued backup of an app source waits for its agent. */
export function RunStatusBadge({
  status,
  sourceKind,
}: {
  status: RunStatus;
  sourceKind?: SourceKind | null;
}) {
  const t = useT(statusMessages);
  const label = status === "queued" && sourceKind === "app" ? t("queuedAgent") : t(status);
  return <ToneBadge tone={RUN_TONES[status]}>{label}</ToneBadge>;
}

/** Queued or running: pages refresh more often until it ends. */
export function isActive(status: RunStatus | SourceStatus): boolean {
  return status === "queued" || status === "running";
}
