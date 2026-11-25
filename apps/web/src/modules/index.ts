import type { AnyRoute } from "@tanstack/react-router";
import { routes as audit } from "./audit/routes";
import { routes as dashboard } from "./dashboard/routes";
import { routes as notifications } from "./notifications/routes";
import { routes as preferences } from "./preferences/routes";
import { routes as runs } from "./runs/routes";
import { routes as sources } from "./sources/routes";
import { routes as target } from "./target/routes";

/** Routes of every module inside the signed-in app. Add new modules here. */
export const appRoutes: AnyRoute[] = [
  ...dashboard,
  ...sources,
  ...runs,
  ...target,
  ...notifications,
  ...audit,
  ...preferences,
];
