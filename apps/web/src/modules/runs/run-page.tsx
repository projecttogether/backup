import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleX, Square, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState, LoadingState } from "@/components/ui/states";
import type { RunDetail } from "@backup/shared/api/runs";
import { Detail, Details } from "@/components/detail";
import { Page, PageHeader } from "@/components/ui/page";
import { isActive, RunStatusBadge } from "@/components/status";
import { When } from "@/components/when";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { runDuration, runQuery, useCancelRun } from "./api";
import { messages } from "./messages";

function RunView({ run }: { run: RunDetail }) {
  const t = useT(messages);
  const format = useFormatter();
  const cancel = useCancelRun();
  const [confirming, setConfirming] = useState(false);
  const duration = runDuration(run);
  const stats = run.stats;
  const count = (value: number | null | undefined) => (value != null ? format.number(value) : "—");
  const size = (value: number | null | undefined) => (value != null ? format.bytes(value) : "—");
  return (
    <Page>
      <PageHeader
        title={run.sourceName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {t(run.kind)} · {t(run.trigger)}
            <RunStatusBadge status={run.status} sourceKind={run.sourceKind} />
          </span>
        }
        actions={
          isActive(run.status) ? (
            <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
              <Square />
              {t("cancel")}
            </Button>
          ) : null
        }
      />
      {run.error ? (
        <Alert variant="destructive">
          <CircleX />
          <AlertTitle>{t("error")}</AlertTitle>
          <AlertDescription className="break-words">{run.error}</AlertDescription>
        </Alert>
      ) : null}
      {run.warnings.length ? (
        <Alert className="border-amber-300 dark:border-amber-500/40">
          <TriangleAlert className="text-amber-600" />
          <AlertTitle>{t("warnings")}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {run.warnings.map((warning, index) => (
                <li key={index} className="break-words">
                  {warning}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("details")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Details>
            <Detail label={t("source")}>
              {run.sourceId ? (
                <Link
                  to="/sources/$id"
                  params={{ id: run.sourceId }}
                  className="text-link underline underline-offset-4"
                >
                  {run.sourceName}
                </Link>
              ) : (
                run.sourceName
              )}
            </Detail>
            <Detail label={t("trigger")}>{t(run.trigger)}</Detail>
            <Detail label={t("queuedAt")}>
              <When value={run.queuedAt} />
            </Detail>
            <Detail label={t("startedAt")}>
              <When value={run.startedAt} empty={t("waiting")} />
            </Detail>
            <Detail label={t("finishedAt")}>
              <When value={run.finishedAt} />
            </Detail>
            <Detail label={t("duration")}>{duration === null ? "—" : format.duration(duration)}</Detail>
            {run.snapshotId ? (
              <Detail label={t("snapshot")}>
                <code className="font-mono text-xs">{run.snapshotId.slice(0, 8)}</code>
              </Detail>
            ) : null}
          </Details>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("stats")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stats ? (
            <Details>
              <Detail label={t("bytesProcessed")}>{size(stats.bytesProcessed)}</Detail>
              <Detail label={t("bytesAdded")}>{size(stats.bytesAdded)}</Detail>
              <Detail label={t("filesProcessed")}>{count(stats.filesProcessed)}</Detail>
              <Detail label={t("filesNew")}>{count(stats.filesNew)}</Detail>
              <Detail label={t("filesChanged")}>{count(stats.filesChanged)}</Detail>
            </Details>
          ) : (
            <p className="text-muted-foreground text-sm">{t("noStats")}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("log")}</h2>
          </CardTitle>
          <CardAction>
            <Button asChild variant="ghost" size="sm">
              <Link to="/runs" search={run.sourceId ? { sourceId: run.sourceId } : {}}>
                {t("allRuns")}
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {run.log.length ? (
            <pre
              tabIndex={0}
              aria-label={t("logLabel")}
              className="bg-muted max-h-[60vh] overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed whitespace-pre"
            >
              {run.log.join("\n")}
            </pre>
          ) : (
            <p className="text-muted-foreground text-sm">{t("noLog")}</p>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("cancelTitle")}
        description={t("cancelText")}
        confirmLabel={t("cancelConfirm")}
        destructive
        onConfirm={() =>
          cancel.mutateAsync(run.id).then(
            () => toast.success(t("cancelled")),
            (error: unknown) => {
              toast.error(errorMessage(error));
              throw error;
            },
          )
        }
      />
    </Page>
  );
}

/** /runs/$id: refreshes every 3 s while the run waits or runs. */
export function RunPage({ id }: { id: string }) {
  const run = useQuery(runQuery(id));
  if (run.isLoading) return <LoadingState />;
  if (run.isError || !run.data) {
    return (
      <Page>
        <ErrorState error={run.error} onRetry={() => void run.refetch()} />
      </Page>
    );
  }
  return <RunView run={run.data} />;
}
