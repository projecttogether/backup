import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Run, RunDetail, RunKind, RunList } from "@backup/shared/api/runs";
import { isActive } from "@/components/status";
import { api } from "@/lib/api";
import { pollEvery } from "@/lib/poll";

export type RunFilter = { sourceId?: string; kind?: RunKind; limit: number; offset: number };

export const runKeys = {
  all: ["runs"] as const,
  list: (filter: RunFilter) => ["runs", "list", filter] as const,
  detail: (id: string) => ["runs", "detail", id] as const,
};

/** Runs, newest first; asks again often while one of them waits or runs. */
export const runsQuery = (filter: RunFilter) =>
  queryOptions({
    queryKey: runKeys.list(filter),
    queryFn: ({ signal }) => api.get<RunList>("/runs", filter, signal),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      pollEvery(query.state.data?.items.some((run) => isActive(run.status)) ?? false),
  });

/** A run with its log; every 3 s while it waits or runs. */
export const runQuery = (id: string) =>
  queryOptions({
    queryKey: runKeys.detail(id),
    queryFn: ({ signal }) => api.get<RunDetail>(`/runs/${id}`, undefined, signal),
    refetchInterval: (query) => (query.state.data && isActive(query.state.data.status) ? 3_000 : false),
  });

/** Refreshes what a run changes: runs, sources and the dashboard. */
export function useRefreshRuns() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: runKeys.all });
    void client.invalidateQueries({ queryKey: ["sources"] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  };
}

export function useCancelRun() {
  const refresh = useRefreshRuns();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Run>(`/runs/${id}/cancel`),
    onSuccess: (run) => {
      client.setQueryData<RunDetail>(runKeys.detail(run.id), (old) => (old ? { ...old, ...run } : old));
      refresh();
    },
  });
}

/** How long a run took, or has run so far; null before it starts. */
export function runDuration(run: Run, now = Date.now()): number | null {
  if (!run.startedAt) return null;
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
  return end - new Date(run.startedAt).getTime();
}
