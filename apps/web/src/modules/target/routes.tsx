import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { appRoute } from "@/routes/app";
import { TargetPage } from "./target-page";

const targetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/target",
  component: TargetPage,
});

export const routes: AnyRoute[] = [targetRoute];
