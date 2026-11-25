import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleX, Info, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";
import type { Attention, Dashboard } from "@backup/shared/api/dashboard";
import type { Run } from "@backup/shared/api/runs";
import type { Target } from "@backup/shared/api/target";
import { Detail, Details } from "@/components/detail";
import { Page, PageHeader } from "@/components/ui/page";
import { RunStatusBadge, ToneBadge } from "@/components/status";
import { When } from "@/components/when";
import { useT } from "@/i18n";
import { useFormatter } from "@/lib/format";
import { RunsTable } from "@/modules/runs/runs-table";
import { KindChoices } from "@/modules/sources/source-form-page";
import { AddSourceButton } from "@/modules/sources/sources-page";
import { SourcesTable } from "@/modules/sources/sources-table";
import { lifecycleComplete, RepositoryStateBadge } from "@/modules/target/parts";
import { dashboardQuery } from "./api";
import { messages } from "./messages";

function AttentionItem({ item }: { item: Attention }) {
  const t = useT(messages);
  const Icon = item.level === "error" ? CircleX : item.level === "warning" ? TriangleAlert : Info;
  return (
    <Alert
      variant={item.level === "error" ? "destructive" : "default"}
      className={item.level === "warning" ? "border-amber-300 dark:border-amber-500/40" : undefined}
    >
      <Icon className={item.level === "warning" ? "text-amber-600" : undefined} />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span>{item.message}</span>
        {item.link ? (
          <Link
            to={item.link}
            aria-label={t("openNamed", { message: item.message })}
            className="text-link shrink-0 font-medium underline underline-offset-4"
          >
            {t("open")}
          </Link>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function OnOff({ value }: { value: boolean | null }) {
  const t = useT(messages);
  if (value === null) return <span className="text-muted-foreground">{t("unknown")}</span>;
  return <ToneBadge tone={value ? "success" : "warning"}>{value ? t("on") : t("off")}</ToneBadge>;
}

function TargetCard({ target }: { target: Target }) {
  const t = useT(messages);
  const format = useFormatter();
  const lifecycle = lifecycleComplete(target.protection);
  const lock = target.protection?.objectLock ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("target")}</h2>
        </CardTitle>
        {target.bucket ? (
          <CardDescription className="font-mono text-xs break-all">
            {target.repositoryUrl ?? target.bucket}
          </CardDescription>
        ) : null}
        <CardAction>
          <Button asChild variant="ghost" size="sm">
            <Link to="/settings/target">{t("targetSettings")}</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {!target.configured ? (
          <p className="text-muted-foreground text-sm">{t("notConfigured")}</p>
        ) : (
          <Details className="lg:grid-cols-2">
            <Detail label={t("repository")}>
              <RepositoryStateBadge state={target.repository.state} />
            </Detail>
            <Detail label={t("stored")}>
              {target.stats?.storedBytes != null ? format.bytes(target.stats.storedBytes) : "—"}
            </Detail>
            <Detail label={t("objectLock")}>
              <OnOff value={lock === null ? null : lock.enabled} />
            </Detail>
            <Detail label={t("lifecycle")}>
              {lifecycle === null ? (
                <span className="text-muted-foreground">{t("unknown")}</span>
              ) : (
                <ToneBadge tone={lifecycle ? "success" : "warning"}>
                  {lifecycle ? t("set") : t("missing")}
                </ToneBadge>
              )}
            </Detail>
            <Detail label={t("lastCheck")}>
              {target.lastCheck ? (
                <span className="flex flex-wrap items-center gap-2">
                  <ToneBadge tone={target.lastCheck.ok ? "success" : "danger"}>
                    {target.lastCheck.ok ? t("passed") : t("failed")}
                  </ToneBadge>
                  <When value={target.lastCheck.at} />
                </span>
              ) : (
                <span className="text-muted-foreground">{t("notYet")}</span>
              )}
            </Detail>
            <Detail label={t("recoveryKit")}>
              <ToneBadge tone={target.recoveryKitConfirmedAt ? "success" : "warning"}>
                {target.recoveryKitConfirmedAt ? t("kitStored") : t("kitNotStored")}
              </ToneBadge>
            </Detail>
          </Details>
        )}
      </CardContent>
    </Card>
  );
}

function RunLine({ run }: { run: Run | null }) {
  const t = useT(messages);
  if (!run) return <span className="text-muted-foreground">{t("notRun")}</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <RunStatusBadge status={run.status} sourceKind={run.sourceKind} />
      <When value={run.finishedAt ?? run.startedAt ?? run.queuedAt} />
      <Link to="/runs/$id" params={{ id: run.id }} className="text-link underline underline-offset-4">
        {t("viewRun")}
      </Link>
    </span>
  );
}

function SystemCard({ dashboard }: { dashboard: Dashboard }) {
  const t = useT(messages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("system")}</h2>
        </CardTitle>
        <CardDescription>
          {t("systemDescription", {
            time: dashboard.target.maintenanceTime,
            zone: dashboard.target.timezone,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Details className="sm:grid-cols-1 lg:grid-cols-1">
          <Detail label={t("upkeep")}>
            <RunLine run={dashboard.maintenance} />
          </Detail>
          <Detail label={t("selfBackup")}>
            <RunLine run={dashboard.selfBackup} />
          </Detail>
        </Details>
      </CardContent>
    </Card>
  );
}

function DashboardView({ dashboard }: { dashboard: Dashboard }) {
  const t = useT(messages);
  const empty = dashboard.sources.length === 0;
  return (
    <>
      {dashboard.attention.length ? (
        <section className="grid gap-3" aria-label={t("title")}>
          {dashboard.attention.map((item, index) => (
            <AttentionItem key={`${index}-${item.message}`} item={item} />
          ))}
        </section>
      ) : null}
      {empty ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("emptyTitle")}</h2>
            </CardTitle>
            <CardDescription>{t("emptyText")}</CardDescription>
            <CardAction>
              <AddSourceButton />
            </CardAction>
          </CardHeader>
          <CardContent>
            <KindChoices />
          </CardContent>
        </Card>
      ) : (
        <Card className="gap-0 pb-0">
          <CardHeader className="pb-4">
            <CardTitle>
              <h2>{t("sources")}</h2>
            </CardTitle>
          </CardHeader>
          <SourcesTable sources={dashboard.sources} />
        </Card>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <TargetCard target={dashboard.target} />
        <SystemCard dashboard={dashboard} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("recentRuns")}</h2>
          </CardTitle>
          <CardAction>
            <Button asChild variant="ghost" size="sm">
              <Link to="/runs">{t("allRuns")}</Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {dashboard.recentRuns.length ? (
            <RunsTable runs={dashboard.recentRuns} />
          ) : (
            <p className="text-muted-foreground text-sm">{t("noRuns")}</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/** /: attention first, then sources, target, system and recent runs. */
export function DashboardPage() {
  const t = useT(messages);
  const dashboard = useQuery(dashboardQuery());
  return (
    <Page>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={dashboard.data?.sources.length ? <AddSourceButton /> : null}
      />
      {dashboard.isLoading ? (
        <LoadingState />
      ) : dashboard.isError || !dashboard.data ? (
        <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      ) : (
        <DashboardView dashboard={dashboard.data} />
      )}
    </Page>
  );
}
