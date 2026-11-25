import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { CircleCheck, CircleX, KeyRound, Pause, Pencil, Play, Plug, Trash2, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SOURCE_KIND_LABELS, type Source, type SourceTest } from "@backup/shared/api/sources";
import { Detail, Details } from "@/components/detail";
import { Page, PageHeader } from "@/components/ui/page";
import { SourceStatusBadge } from "@/components/status";
import { When } from "@/components/when";
import { useT } from "@/i18n";
import { common } from "@/i18n/common";
import { errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { runsQuery } from "@/modules/runs/api";
import { RunsTable } from "@/modules/runs/runs-table";
import {
  snapshotDownloadUrl,
  snapshotsQuery,
  sourceQuery,
  useDeleteSource,
  useNewToken,
  useTestSource,
  useUpdateSource,
} from "./api";
import { sourceToInput } from "./form";
import { messages } from "./messages";
import { AgentTokenDialog, BackUpNowButton, envLines, useRetentionList, useScheduleText } from "./parts";

function TestResult({ result, onDismiss }: { result: SourceTest; onDismiss: () => void }) {
  const t = useT(messages);
  const format = useFormatter();
  const facts = [
    result.items !== null ? `${t("testItems")}: ${format.number(result.items)}` : null,
    result.bytes !== null ? `${t("testSize")}: ${format.bytes(result.bytes)}` : null,
    result.freeBytes !== null ? `${t("testFree")}: ${format.bytes(result.freeBytes)}` : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <Alert variant={result.ok ? "default" : "destructive"} role="status">
      {result.ok ? <CircleCheck className="text-emerald-600" /> : <CircleX />}
      <AlertTitle>{result.ok ? t("testOk") : t("testFailed")}</AlertTitle>
      <AlertDescription>
        <p>{result.message}</p>
        {facts.length ? (
          <ul className="mt-1 list-disc pl-4">
            {facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        ) : null}
        <Button type="button" variant="ghost" size="sm" className="mt-1 -ml-2" onClick={onDismiss}>
          <X />
          {t("dismiss")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function DeleteDialog(props: { source: Source; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT(messages);
  const tc = useT(common);
  const navigate = useNavigate();
  const remove = useDeleteSource();
  const [snapshots, setSnapshots] = useState<"keep" | "forget">("keep");
  const confirm = () =>
    remove.mutate(
      { id: props.source.id, snapshots },
      {
        onSuccess: () => {
          toast.success(t("deleted"));
          props.onOpenChange(false);
          void navigate({ to: "/sources" });
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  return (
    <Dialog open={props.open} onOpenChange={(open) => !remove.isPending && props.onOpenChange(open)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("deleteTitle", { name: props.source.name })}</DialogTitle>
          <DialogDescription>{t("deleteText")}</DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={snapshots}
          onValueChange={(value) => setSnapshots(value as "keep" | "forget")}
          className="gap-4"
        >
          <div className="flex items-start gap-3">
            <RadioGroupItem
              id="delete-keep"
              value="keep"
              aria-describedby="delete-keep-hint"
              className="mt-0.5"
            />
            <div className="grid gap-1">
              <Label htmlFor="delete-keep">{t("keepSnapshots")}</Label>
              <p id="delete-keep-hint" className="text-muted-foreground text-sm">
                {t("keepSnapshotsHint")}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <RadioGroupItem
              id="delete-forget"
              value="forget"
              aria-describedby="delete-forget-hint"
              className="mt-0.5"
            />
            <div className="grid gap-1">
              <Label htmlFor="delete-forget">{t("forgetSnapshots")}</Label>
              <p id="delete-forget-hint" className="text-muted-foreground text-sm">
                {t("forgetSnapshotsHint")}
              </p>
            </div>
          </div>
        </RadioGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => props.onOpenChange(false)}
          >
            {tc("cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={remove.isPending} onClick={confirm}>
            {remove.isPending ? <Spinner /> : null}
            {t("deleteConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OverviewCard({ source }: { source: Source }) {
  const t = useT(messages);
  const format = useFormatter();
  const scheduleText = useScheduleText();
  const retentionList = useRetentionList();
  const kept = retentionList(source.retention);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("overview")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Details>
          <Detail label={t("schedule")}>
            {scheduleText(source.schedule)}
            {source.enabled ? null : <span className="text-muted-foreground"> · {t("pausedToast")}</span>}
          </Detail>
          <Detail label={t("retention")}>
            {kept ? t("retentionSummary", { list: kept }) : t("retentionNone")}
          </Detail>
          <Detail label={t("nextRun")}>
            <When value={source.enabled ? source.nextRunAt : null} empty={t("notScheduled")} />
          </Detail>
          <Detail label={t("lastSuccess")}>
            <When value={source.lastSuccessAt} empty={t("none")} />
          </Detail>
          {source.kind === "s3_bucket" ? (
            <>
              <Detail label={t("bucket")}>
                <code className="font-mono text-xs break-all">
                  {source.config.prefix
                    ? `${source.config.bucket}/${source.config.prefix}`
                    : source.config.bucket}
                </code>
              </Detail>
              <Detail label={t("endpoint")}>
                <code className="font-mono text-xs break-all">{source.config.endpoint}</code>
              </Detail>
            </>
          ) : null}
          <Detail label={t("lastSnapshot")}>
            {source.lastSnapshot ? (
              <>
                {source.lastSnapshot.bytes !== null ? format.bytes(source.lastSnapshot.bytes) : "—"}
                {source.lastSnapshot.files !== null
                  ? ` · ${t("filesCount", { count: source.lastSnapshot.files })}`
                  : ""}
              </>
            ) : (
              <span className="text-muted-foreground">{t("none")}</span>
            )}
          </Detail>
        </Details>
      </CardContent>
    </Card>
  );
}

function AgentCard({
  source,
  onNewToken,
}: {
  source: Extract<Source, { kind: "app" }>;
  onNewToken: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const agent = source.agent;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("agent")}</h2>
        </CardTitle>
        <CardDescription>{t("agentDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {agent.lastSeenAt === null ? (
          <div className="grid gap-3 text-sm">
            <p className="font-medium">{t("notSeen")}</p>
            <ol className="text-muted-foreground grid list-decimal gap-2 pl-5">
              <li>{t("setup1")}</li>
              <li className="grid gap-2">
                <span>{t("setup2")}</span>
                <pre className="bg-muted text-foreground overflow-x-auto rounded-md px-3 py-2 font-mono text-xs">
                  {envLines("<token>")}
                </pre>
                <span>
                  {t("setupLostToken")}{" "}
                  <Button type="button" variant="link" className="h-auto p-0" onClick={onNewToken}>
                    {t("newToken")}
                  </Button>
                </span>
              </li>
              <li>{t("setup3")}</li>
            </ol>
          </div>
        ) : (
          <Details>
            <Detail label={t("agentLastSeen")}>
              <When value={agent.lastSeenAt} />
            </Detail>
            <Detail label={t("agentVersion")}>{agent.version ?? "—"}</Detail>
            <Detail label={t("agentApp")}>{agent.appName || "—"}</Detail>
            <Detail label={t("agentImage")}>
              {agent.appImage ? <code className="font-mono text-xs break-all">{agent.appImage}</code> : "—"}
            </Detail>
            <Detail label={t("agentDatabase")}>
              {agent.database === null ? "—" : agent.database ? tc("yes") : tc("no")}
            </Detail>
            <Detail label={t("agentVolumes")}>
              {agent.volumes.length ? (
                <ul>
                  {agent.volumes.map((volume) => (
                    <li key={volume}>
                      <code className="font-mono text-xs break-all">{volume}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                t("none")
              )}
            </Detail>
            {agent.tokenHint ? (
              <Detail label={t("agentToken")}>{t("tokenEnding", { hint: agent.tokenHint })}</Detail>
            ) : null}
          </Details>
        )}
        {agent.secrets.length > 0 ? (
          <p className="mt-4 text-sm">{t("agentSecrets", { names: agent.secrets.join(", ") })}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SnapshotsCard({ source }: { source: Source }) {
  const t = useT(messages);
  const format = useFormatter();
  const snapshots = useQuery(snapshotsQuery(source.id));
  const { refetch } = snapshots;
  // A backup that just ended added a snapshot (the source refreshes while it runs).
  const latest = source.lastSnapshot?.id;
  useEffect(() => {
    if (latest) void refetch();
  }, [latest, refetch]);
  const kind = source.kind === "app" ? "tar" : "zip";
  const items = [...(snapshots.data?.items ?? [])].sort((a, b) => b.time.localeCompare(a.time));
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("snapshots")}</h2>
        </CardTitle>
        <CardDescription>{t("snapshotsHint", { format: kind })}</CardDescription>
      </CardHeader>
      <CardContent>
        {snapshots.isLoading ? (
          <LoadingState />
        ) : snapshots.isError ? (
          <ErrorState error={snapshots.error} onRetry={() => void snapshots.refetch()} />
        ) : items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noSnapshots")}</p>
        ) : (
          <Table scrollLabel={t("snapshotsTable")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colTime")}</TableHead>
                <TableHead className="text-right">{t("colSize")}</TableHead>
                <TableHead className="text-right">{t("colFiles")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("download")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((snapshot) => (
                <TableRow key={snapshot.id}>
                  <TableCell>
                    <time dateTime={snapshot.time}>{format.dateTime(snapshot.time)}</time>
                    <div className="text-muted-foreground font-mono text-xs">{snapshot.id.slice(0, 8)}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {snapshot.bytes !== null ? format.bytes(snapshot.bytes) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {snapshot.files !== null ? format.number(snapshot.files) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={snapshotDownloadUrl(source.id, snapshot.id)}
                        download
                        aria-label={t("downloadLabel", {
                          time: format.dateTime(snapshot.time),
                          format: kind,
                        })}
                      >
                        {t("download")}
                      </a>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function RecentRunsCard({ sourceId, lastRun }: { sourceId: string; lastRun: string | null }) {
  const t = useT(messages);
  const runs = useQuery(runsQuery({ sourceId, limit: 10, offset: 0 }));
  const { refetch } = runs;
  // The newest run started or changed its status: show it.
  useEffect(() => {
    if (lastRun) void refetch();
  }, [lastRun, refetch]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("recentRuns")}</h2>
        </CardTitle>
        <CardAction>
          <Button asChild variant="ghost" size="sm">
            <Link to="/runs" search={{ sourceId }}>
              {t("allRuns")}
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {runs.isLoading ? (
          <LoadingState />
        ) : runs.isError || !runs.data ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : runs.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noRuns")}</p>
        ) : (
          <RunsTable runs={runs.data.items} />
        )}
      </CardContent>
    </Card>
  );
}

function SourceView({ source }: { source: Source }) {
  const t = useT(messages);
  const test = useTestSource();
  const update = useUpdateSource();
  const newToken = useNewToken();
  const [testResult, setTestResult] = useState<SourceTest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmToken, setConfirmToken] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const runTest = () =>
    test.mutate(source.id, {
      onSuccess: setTestResult,
      onError: (error) => toast.error(errorMessage(error)),
    });
  const toggle = () =>
    update.mutate(
      { id: source.id, input: sourceToInput(source, { enabled: !source.enabled }) },
      {
        onSuccess: (saved) => toast.success(saved.enabled ? t("resumedToast") : t("pausedToast")),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  const createToken = () =>
    newToken.mutateAsync(source.id).then(
      (created) => setToken(created.token),
      (error: unknown) => {
        toast.error(errorMessage(error));
        throw error;
      },
    );

  return (
    <Page>
      <PageHeader
        title={source.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {SOURCE_KIND_LABELS[source.kind]}
            <SourceStatusBadge status={source.status} kind={source.kind} />
          </span>
        }
        actions={
          <>
            <BackUpNowButton source={source} />
            <Button type="button" variant="outline" disabled={test.isPending} onClick={runTest}>
              {test.isPending ? <Spinner /> : <Plug />}
              {t("test")}
            </Button>
            <Button asChild variant="outline">
              <Link to="/sources/$id/edit" params={{ id: source.id }}>
                <Pencil />
                {t("edit")}
              </Link>
            </Button>
            <Button type="button" variant="outline" disabled={update.isPending} onClick={toggle}>
              {update.isPending ? <Spinner /> : source.enabled ? <Pause /> : <Play />}
              {source.enabled ? t("pause") : t("resume")}
            </Button>
            {source.kind === "app" ? (
              <Button type="button" variant="outline" onClick={() => setConfirmToken(true)}>
                <KeyRound />
                {t("newToken")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => setDeleting(true)}>
              <Trash2 />
              {t("delete")}
            </Button>
          </>
        }
      />
      {testResult ? <TestResult result={testResult} onDismiss={() => setTestResult(null)} /> : null}
      <OverviewCard source={source} />
      {source.kind === "app" ? <AgentCard source={source} onNewToken={() => setConfirmToken(true)} /> : null}
      <SnapshotsCard source={source} />
      <RecentRunsCard
        sourceId={source.id}
        lastRun={source.lastRun ? `${source.lastRun.id}:${source.lastRun.status}` : null}
      />
      <DeleteDialog source={source} open={deleting} onOpenChange={setDeleting} />
      <ConfirmDialog
        open={confirmToken}
        onOpenChange={setConfirmToken}
        title={t("newTokenTitle")}
        description={t("newTokenText")}
        confirmLabel={t("newTokenConfirm")}
        destructive
        onConfirm={createToken}
      />
      <AgentTokenDialog token={token} onDone={() => setToken(null)} />
    </Page>
  );
}

/** /sources/$id */
export function SourcePage({ id }: { id: string }) {
  const source = useQuery(sourceQuery(id));
  if (source.isLoading) return <LoadingState />;
  if (source.isError || !source.data) {
    return (
      <Page>
        <ErrorState error={source.error} onRetry={() => void source.refetch()} />
      </Page>
    );
  }
  return <SourceView source={source.data} />;
}
