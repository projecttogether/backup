import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Pager } from "@/components/ui/pager";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { runKindSchema, type RunKind } from "@backup/shared/api/runs";
import { Page, PageHeader } from "@/components/ui/page";
import { useT } from "@/i18n";
import { sourcesQuery } from "@/modules/sources/api";
import { runsQuery } from "./api";
import { messages } from "./messages";
import { RunsTable } from "./runs-table";

const PAGE_SIZE = 50;

export type RunsSearch = { sourceId?: string; kind?: RunKind; page?: number };

/** /runs: every run, filtered by source and kind, page by page. */
export function RunsPage(props: { search: RunsSearch; onSearch: (search: RunsSearch) => void }) {
  const t = useT(messages);
  const page = props.search.page ?? 1;
  const filter = {
    sourceId: props.search.sourceId,
    kind: props.search.kind,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
  const runs = useQuery(runsQuery(filter));
  const sources = useQuery(sourcesQuery()).data?.items ?? [];
  const filtered = Boolean(props.search.sourceId || props.search.kind);
  return (
    <Page>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="flex flex-wrap gap-4">
        <Field className="w-full sm:w-64">
          <FieldLabel htmlFor="runs-source">{t("filterSource")}</FieldLabel>
          <NativeSelect
            id="runs-source"
            wrapperClassName="w-full"
            value={props.search.sourceId ?? ""}
            onChange={(event) =>
              props.onSearch({ ...props.search, sourceId: event.target.value || undefined, page: undefined })
            }
          >
            <NativeSelectOption value="">{t("allSources")}</NativeSelectOption>
            {sources.map((source) => (
              <NativeSelectOption key={source.id} value={source.id}>
                {source.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="w-full sm:w-56">
          <FieldLabel htmlFor="runs-kind">{t("filterKind")}</FieldLabel>
          <NativeSelect
            id="runs-kind"
            wrapperClassName="w-full"
            value={props.search.kind ?? ""}
            onChange={(event) =>
              props.onSearch({
                ...props.search,
                kind: (event.target.value || undefined) as RunKind | undefined,
                page: undefined,
              })
            }
          >
            <NativeSelectOption value="">{t("allKinds")}</NativeSelectOption>
            {runKindSchema.options.map((kind) => (
              <NativeSelectOption key={kind} value={kind}>
                {t(kind)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {runs.isLoading ? (
        <LoadingState />
      ) : runs.isError || !runs.data ? (
        <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
      ) : runs.data.items.length === 0 ? (
        <EmptyState
          icon={<History />}
          title={t("empty")}
          description={filtered ? t("emptyFiltered") : t("emptyHint")}
        />
      ) : (
        <>
          <Card className="py-0">
            <RunsTable runs={runs.data.items} />
          </Card>
          <Pager
            page={page}
            pageSize={PAGE_SIZE}
            total={runs.data.total}
            onPage={(next) => props.onSearch({ ...props.search, page: next > 1 ? next : undefined })}
          />
        </>
      )}
    </Page>
  );
}
