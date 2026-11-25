import audit from "./audit";
import dashboard from "./dashboard";
import meta from "./meta";
import notifications from "./notifications";
import runs from "./runs";
import sources from "./sources";
import target from "./target";

/** Routers mounted under /api/v1. */
export const API_MODULES = [meta, dashboard, sources, runs, target, notifications, audit];
