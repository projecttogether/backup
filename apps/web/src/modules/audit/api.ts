import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { AuditList } from "@backup/shared/api/users";
import { api } from "@/lib/api";

/** The newest entries first. */
export const auditQuery = (limit: number, offset: number) =>
  queryOptions({
    queryKey: ["audit", { limit, offset }],
    queryFn: ({ signal }) => api.get<AuditList>("/audit", { limit, offset }, signal),
    placeholderData: keepPreviousData,
  });
