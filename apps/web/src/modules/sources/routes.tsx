import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sourceKindSchema } from "@backup/shared/api/sources";
import { appRoute } from "@/routes/app";
import { EditSourcePage, NewSourcePage } from "./source-form-page";
import { SourcePage } from "./source-page";
import { SourcesPage } from "./sources-page";

const sourcesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sources",
  component: SourcesPage,
});

const newSourceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sources/new",
  validateSearch: z.object({ kind: sourceKindSchema.optional().catch(undefined) }),
  component: function NewSourceRoute() {
    const { kind } = newSourceRoute.useSearch();
    return <NewSourcePage kind={kind} />;
  },
});

const sourceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sources/$id",
  component: function SourceRoute() {
    const { id } = sourceRoute.useParams();
    return <SourcePage key={id} id={id} />;
  },
});

const editSourceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sources/$id/edit",
  component: function EditSourceRoute() {
    const { id } = editSourceRoute.useParams();
    return <EditSourcePage key={id} id={id} />;
  },
});

export const routes: AnyRoute[] = [sourcesRoute, newSourceRoute, sourceRoute, editSourceRoute];
