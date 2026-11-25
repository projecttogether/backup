import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { Me } from "@backup/shared/api/users";
import { api } from "@/lib/api";

export const meQuery = { queryKey: ["me"] as const, queryFn: () => api.get<Me>("/me"), staleTime: 60_000 };

/** The signed-in person. Only use inside the signed-in app (its route loads it first). */
export function useMe(): Me {
  return useSuspenseQuery(meQuery).data;
}

/** The signed-in person, or undefined while loading or signed out. */
export function useMaybeMe(): Me | undefined {
  return useQuery({ ...meQuery, retry: false }).data;
}

/** Only admins sign in; the check covers a role that changes while the app is open. */
export function useIsAdmin(): boolean {
  return useMe().isAdmin;
}
