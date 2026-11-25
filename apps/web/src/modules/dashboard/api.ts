import { queryOptions } from "@tanstack/react-query";
import type { Dashboard } from "@backup/shared/api/dashboard";
import { isActive } from "@/components/status";
import { api } from "@/lib/api";
import { pollEvery } from "@/lib/poll";

/** Something waits or runs: the dashboard then asks every 10 s instead of every minute. */
export function dashboardBusy(dashboard: Dashboard): boolean {
  return (
    dashboard.sources.some((source) => isActive(source.status)) ||
    dashboard.recentRuns.some((run) => isActive(run.status)) ||
    [dashboard.maintenance, dashboard.selfBackup].some((run) => run !== null && isActive(run.status))
  );
}

export const dashboardQuery = () =>
  queryOptions({
    queryKey: ["dashboard"],
    queryFn: ({ signal }) => api.get<Dashboard>("/dashboard", undefined, signal),
    refetchInterval: (query) => pollEvery(query.state.data ? dashboardBusy(query.state.data) : false),
  });
