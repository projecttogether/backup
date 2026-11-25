import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Notifications, NotificationsInput, TestResult } from "@backup/shared/api/notifications";
import { api } from "@/lib/api";

export const notificationKeys = { notifications: ["notifications"] as const };

export const notificationsQuery = () =>
  queryOptions({
    queryKey: notificationKeys.notifications,
    queryFn: ({ signal }) => api.get<Notifications>("/notifications", undefined, signal),
  });

export function useSaveNotifications() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NotificationsInput) => api.put<Notifications>("/notifications", input),
    onSuccess: (saved) => client.setQueryData(notificationKeys.notifications, saved),
  });
}

/** Sends a test email to the recipients, with the saved settings. */
export function useTestEmail() {
  return useMutation({ mutationFn: () => api.post<TestResult>("/notifications/test-email") });
}

/** Calls the saved heartbeat URL once; the page then shows the call. */
export function useTestHeartbeat() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<TestResult>("/notifications/test-heartbeat"),
    onSettled: () => void client.invalidateQueries({ queryKey: notificationKeys.notifications }),
  });
}
