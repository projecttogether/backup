import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { appRoute } from "@/routes/app";
import { NotificationsPage } from "./notifications-page";

const notificationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/notifications",
  component: NotificationsPage,
});

export const routes: AnyRoute[] = [notificationsRoute];
