import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { HardDrive, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Page, PageHeader } from "@/components/ui/page";
import { useT } from "@/i18n";
import { sourcesQuery } from "./api";
import { messages } from "./messages";
import { KindChoices } from "./source-form-page";
import { SourcesTable } from "./sources-table";

export function AddSourceButton() {
  const t = useT(messages);
  return (
    <Button asChild>
      <Link to="/sources/new">
        <Plus />
        {t("add")}
      </Link>
    </Button>
  );
}

export function SourcesPage() {
  const t = useT(messages);
  const sources = useQuery(sourcesQuery());
  return (
    <Page>
      <PageHeader title={t("title")} description={t("description")} actions={<AddSourceButton />} />
      {sources.isLoading ? (
        <LoadingState />
      ) : sources.isError || !sources.data ? (
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      ) : sources.data.items.length === 0 ? (
        <>
          <EmptyState icon={<HardDrive />} title={t("noSources")} description={t("noSourcesHint")} />
          <KindChoices />
        </>
      ) : (
        <Card className="py-0">
          <SourcesTable sources={sources.data.items} showSchedule />
        </Card>
      )}
    </Page>
  );
}
