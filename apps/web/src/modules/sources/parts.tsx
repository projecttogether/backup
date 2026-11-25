import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Building2,
  CloudUpload,
  HardDrive,
  Package,
  Play,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { SecretInput } from "@/components/ui/secret-input";
import { Spinner } from "@/components/ui/spinner";
import type { Retention, Schedule } from "@backup/shared/api/schedule";
import type { Source, SourceKind } from "@backup/shared/api/sources";
import { isActive } from "@/components/status";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useRunSource } from "./api";
import { messages } from "./messages";

export const KIND_ICONS: Record<SourceKind, LucideIcon> = {
  app: Package,
  google_drive: CloudUpload,
  personio: Building2,
  s3_bucket: HardDrive,
};

/** What each kind backs up, for the kind chooser and the empty dashboard. */
export const KIND_TEXTS = {
  app: "kindApp",
  google_drive: "kindGoogleDrive",
  personio: "kindPersonio",
  s3_bucket: "kindS3Bucket",
} as const satisfies Record<SourceKind, keyof typeof messages.en>;

const DAY_KEYS = ["day0", "day1", "day2", "day3", "day4", "day5", "day6"] as const;

export function useDayName() {
  const t = useT(messages);
  return (day: number) => t(DAY_KEYS[day] ?? "day0");
}

/** "Daily at 02:00", "Every 6 hours at minute 15", "Weekly on Monday at 02:00". */
export function useScheduleText() {
  const t = useT(messages);
  const dayName = useDayName();
  return (schedule: Schedule) => {
    if (schedule.type === "hourly")
      return t("scheduleHourly", { count: schedule.every, minute: String(schedule.minute).padStart(2, "0") });
    if (schedule.type === "daily") return t("scheduleDaily", { time: schedule.time });
    return t("scheduleWeekly", { day: dayName(schedule.day), time: schedule.time });
  };
}

const list = new Intl.ListFormat("en-US", { type: "conjunction" });

/** "14 days, 8 weeks, and 12 months", or null when nothing is kept. */
export function useRetentionList() {
  const t = useT(messages);
  return (retention: Retention) => {
    const parts = [
      retention.daily > 0 ? t("days", { count: retention.daily }) : null,
      retention.weekly > 0 ? t("weeks", { count: retention.weekly }) : null,
      retention.monthly > 0 ? t("months", { count: retention.monthly }) : null,
      retention.yearly > 0 ? t("years", { count: retention.yearly }) : null,
    ].filter((part): part is string => part !== null);
    return parts.length ? list.format(parts) : null;
  };
}

/** Starts a backup of a source, with a toast that leads to the run. */
export function BackUpNowButton(props: {
  source: Source;
  size?: "sm" | "default";
  variant?: "default" | "outline";
  /** Name the source in the button's accessible name (in tables). */
  named?: boolean;
}) {
  const t = useT(messages);
  const navigate = useNavigate();
  const run = useRunSource();
  const busy = isActive(props.source.status);
  const start = () =>
    run.mutate(props.source.id, {
      onSuccess: (started) =>
        toast.success(props.source.kind === "app" ? t("backupQueuedAgent") : t("backupStarted"), {
          action: {
            label: t("viewRun"),
            onClick: () => void navigate({ to: "/runs/$id", params: { id: started.id } }),
          },
        }),
      onError: (error) => toast.error(errorMessage(error)),
    });
  return (
    <Button
      type="button"
      size={props.size ?? "default"}
      variant={props.variant ?? "default"}
      disabled={run.isPending || busy}
      aria-label={props.named ? t("backUpNamed", { name: props.source.name }) : undefined}
      onClick={start}
    >
      {run.isPending ? <Spinner /> : <Play />}
      {t("backUpNow")}
    </Button>
  );
}

/** The two lines of the app server's .env file. */
export function envLines(token: string): string {
  return `BACKUP_URL=${window.location.origin}\nBACKUP_TOKEN=${token}`;
}

/** Stands for the token in the .env lines on screen; "Copy lines" copies the real token. */
const TOKEN_MASK = "••••••••";

/** Shows a new agent token once, hidden, with the .env lines for the backup agent. */
export function AgentTokenDialog(props: { token: string | null; onDone: () => void }) {
  const t = useT(messages);
  const lines = props.token ? envLines(props.token) : "";
  return (
    <Dialog open={props.token !== null} onOpenChange={(open) => !open && props.onDone()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("tokenTitle")}</DialogTitle>
          <DialogDescription>{t("envLines")}</DialogDescription>
        </DialogHeader>
        <Alert>
          <TriangleAlert />
          <AlertDescription>{t("tokenOnce")}</AlertDescription>
        </Alert>
        <Field>
          <FieldLabel htmlFor="agent-token">{t("token")}</FieldLabel>
          <SecretInput
            id="agent-token"
            readOnly
            copyable
            value={props.token ?? ""}
            inputClassName="font-mono text-xs"
            onFocus={(event) => event.target.select()}
          />
        </Field>
        <div className="grid gap-2">
          <pre
            aria-label={t("envLinesLabel")}
            className="bg-muted overflow-x-auto rounded-md px-3 py-2 font-mono text-xs"
          >
            {envLines(TOKEN_MASK)}
          </pre>
          <div>
            <CopyButton text={lines} label={t("copyLines")} />
          </div>
        </div>
        <p className="text-muted-foreground text-sm">{t("agentNote")}</p>
        <DialogFooter>
          <Button type="button" onClick={props.onDone}>
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
