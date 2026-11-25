import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { runKindSchema } from "@backup/shared/api/runs";
import { appRoute } from "@/routes/app";
import { RunPage } from "./run-page";
import { RunsPage } from "./runs-page";

const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/runs",
  validateSearch: z.object({
    sourceId: z.uuid().optional().catch(undefined),
    kind: runKindSchema.optional().catch(undefined),
    page: z.coerce.number().int().min(1).max(100_000).optional().catch(undefined),
  }),
  component: function RunsRoute() {
    const search = runsRoute.useSearch();
    const navigate = runsRoute.useNavigate();
    return <RunsPage search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});

const runRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/runs/$id",
  component: function RunRoute() {
    const { id } = runRoute.useParams();
    return <RunPage key={id} id={id} />;
  },
});

export const routes: AnyRoute[] = [runsRoute, runRoute];
