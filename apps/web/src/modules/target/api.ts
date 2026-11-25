import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Run } from "@backup/shared/api/runs";
import type { Target, TargetInput } from "@backup/shared/api/target";
import { api, apiUrl } from "@/lib/api";
import { useRefreshRuns } from "@/modules/runs/api";

export const targetKeys = { target: ["target"] as const };

export const targetQuery = () =>
  queryOptions({
    queryKey: targetKeys.target,
    queryFn: ({ signal }) => api.get<Target>("/target", undefined, signal),
  });

/** A plain link: the browser downloads the recovery kit as a text file. */
export const recoveryKitUrl = () => apiUrl("/target/recovery-kit");

/** Every target call answers with the target; the dashboard shows it too. */
function useTargetMutation<Input>(call: (input: Input) => Promise<Target>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (target) => {
      client.setQueryData(targetKeys.target, target);
      void client.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export const useSaveTarget = () =>
  useTargetMutation((input: TargetInput) => api.put<Target>("/target", input));
export const useTestTarget = () => useTargetMutation(() => api.post<Target>("/target/test"));
export const useInitializeTarget = () => useTargetMutation(() => api.post<Target>("/target/initialize"));
export const useConnectTarget = () =>
  useTargetMutation((password: string) => api.post<Target>("/target/connect", { password }));
export const useConfirmRecoveryKit = () =>
  useTargetMutation(() => api.post<Target>("/target/recovery-kit/confirm"));
export const useSaveMaintenance = () =>
  useTargetMutation((maintenanceTime: string) => api.put<Target>("/target/maintenance", { maintenanceTime }));

/** Starts the upkeep now: retention, prune, integrity check and this app's own database. */
export function useRunMaintenance() {
  const refresh = useRefreshRuns();
  return useMutation({ mutationFn: () => api.post<Run>("/maintenance/run"), onSuccess: refresh });
}
