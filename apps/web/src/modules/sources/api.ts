import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AgentToken,
  SnapshotList,
  Source,
  SourceCreated,
  SourceInput,
  SourceList,
  SourceTest,
} from "@backup/shared/api/sources";
import type { Run } from "@backup/shared/api/runs";
import { isActive } from "@/components/status";
import { api, apiUrl } from "@/lib/api";
import { pollEvery } from "@/lib/poll";
import { useRefreshRuns } from "@/modules/runs/api";

export const sourceKeys = {
  all: ["sources"] as const,
  list: ["sources", "list"] as const,
  detail: (id: string) => ["sources", "detail", id] as const,
  snapshots: (id: string) => ["sources", "snapshots", id] as const,
};

export const sourcesQuery = () =>
  queryOptions({
    queryKey: sourceKeys.list,
    queryFn: ({ signal }) => api.get<SourceList>("/sources", undefined, signal),
    refetchInterval: (query) =>
      pollEvery(query.state.data?.items.some((source) => isActive(source.status)) ?? false),
  });

export const sourceQuery = (id: string) =>
  queryOptions({
    queryKey: sourceKeys.detail(id),
    queryFn: ({ signal }) => api.get<Source>(`/sources/${id}`, undefined, signal),
    refetchInterval: (query) => pollEvery(query.state.data ? isActive(query.state.data.status) : false),
  });

export const snapshotsQuery = (id: string) =>
  queryOptions({
    queryKey: sourceKeys.snapshots(id),
    queryFn: ({ signal }) => api.get<SnapshotList>(`/sources/${id}/snapshots`, undefined, signal),
  });

/** A plain link: the browser downloads the tar (app sources) or zip (the others). */
export function snapshotDownloadUrl(sourceId: string, snapshotId: string): string {
  return apiUrl(`/sources/${sourceId}/snapshots/${snapshotId}/download`);
}

/** Starts a backup now; the run waits for the worker or, for app sources, the agent. */
export function useRunSource() {
  const refresh = useRefreshRuns();
  return useMutation({
    mutationFn: (id: string) => api.post<Run>(`/sources/${id}/run`),
    onSuccess: refresh,
  });
}

export function useTestSource() {
  return useMutation({ mutationFn: (id: string) => api.post<SourceTest>(`/sources/${id}/test`) });
}

function useSourceChanged() {
  const client = useQueryClient();
  return (source: Source) => {
    client.setQueryData(sourceKeys.detail(source.id), source);
    void client.invalidateQueries({ queryKey: sourceKeys.list });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  };
}

export function useCreateSource() {
  const changed = useSourceChanged();
  return useMutation({
    mutationFn: (input: SourceInput) => api.post<SourceCreated>("/sources", input),
    onSuccess: (created) => changed(created.source),
  });
}

export function useUpdateSource() {
  const changed = useSourceChanged();
  return useMutation({
    mutationFn: (input: { id: string; input: SourceInput }) =>
      api.put<Source>(`/sources/${input.id}`, input.input),
    onSuccess: changed,
  });
}

export function useDeleteSource() {
  const client = useQueryClient();
  const refresh = useRefreshRuns();
  return useMutation({
    mutationFn: (input: { id: string; snapshots: "keep" | "forget" }) =>
      api.delete(`/sources/${input.id}`, { snapshots: input.snapshots }),
    onSuccess: (_result, input) => {
      client.removeQueries({ queryKey: sourceKeys.detail(input.id) });
      client.removeQueries({ queryKey: sourceKeys.snapshots(input.id) });
      refresh();
    },
  });
}

/** A new agent token for an app source; the old one stops working. */
export function useNewToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<AgentToken>(`/sources/${id}/token`),
    onSuccess: (_token, id) => void client.invalidateQueries({ queryKey: sourceKeys.detail(id) }),
  });
}
