import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RunDetail } from "@backup/shared/api/runs";
import type { Source } from "@backup/shared/api/sources";
import { runKeys } from "@/modules/runs/api";
import { sourceKeys } from "@/modules/sources/api";

/**
 * The name of the source or run a page shows, for its breadcrumbs, from the
 * data the page loaded: nothing more is fetched. A run goes by its source's
 * name, as on its page. Undefined until the page has it.
 */
export function useRecordName(record: { kind: "source" | "run"; id: string } | null): string | undefined {
  const client = useQueryClient();
  const subscribe = useCallback(
    (listener: () => void) => client.getQueryCache().subscribe(listener),
    [client],
  );
  return useSyncExternalStore(subscribe, () => {
    if (record?.kind === "source") return client.getQueryData<Source>(sourceKeys.detail(record.id))?.name;
    if (record?.kind === "run") return client.getQueryData<RunDetail>(runKeys.detail(record.id))?.sourceName;
    return undefined;
  });
}
