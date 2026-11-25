import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { SOURCE_KIND_LABELS, SOURCE_KINDS, type SourceKind } from "@backup/shared/api/sources";
import { Page, PageHeader } from "@/components/ui/page";
import { useT } from "@/i18n";
import { sourceQuery } from "./api";
import { messages } from "./messages";
import { KIND_ICONS, KIND_TEXTS } from "./parts";
import { SourceForm } from "./source-form";

/** The kinds, each a link to its form. */
export function KindChoices() {
  const t = useT(messages);
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {SOURCE_KINDS.map((kind) => {
        const Icon = KIND_ICONS[kind];
        return (
          <li key={kind}>
            <Link
              to="/sources/new"
              search={{ kind }}
              className="bg-card hover:bg-accent focus-visible:ring-ring/50 flex h-full items-start gap-3 rounded-xl border p-4 transition-colors outline-none focus-visible:ring-[3px]"
            >
              <span className="bg-primary/10 text-link flex size-9 shrink-0 items-center justify-center rounded-lg">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="grid flex-1 gap-1">
                <span className="font-medium">{SOURCE_KIND_LABELS[kind]}</span>
                <span className="text-muted-foreground text-sm">{t(KIND_TEXTS[kind])}</span>
              </span>
              <ChevronRight className="text-muted-foreground mt-1 size-4 shrink-0" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** /sources/new: choose the kind, then fill in its form. */
export function NewSourcePage({ kind }: { kind?: SourceKind }) {
  const t = useT(messages);
  if (!kind) {
    return (
      <Page className="max-w-5xl">
        <PageHeader title={t("chooseTitle")} description={t("chooseDescription")} />
        <KindChoices />
      </Page>
    );
  }
  return (
    <Page className="max-w-3xl">
      <PageHeader title={t("newTitle", { kind: SOURCE_KIND_LABELS[kind] })} />
      <SourceForm key={kind} kind={kind} />
    </Page>
  );
}

/** /sources/$id/edit */
export function EditSourcePage({ id }: { id: string }) {
  const t = useT(messages);
  const source = useQuery({ ...sourceQuery(id), refetchInterval: false });
  if (source.isLoading) return <LoadingState />;
  if (source.isError || !source.data) {
    return (
      <Page>
        <ErrorState error={source.error} onRetry={() => void source.refetch()} />
      </Page>
    );
  }
  return (
    <Page className="max-w-3xl">
      <PageHeader
        title={t("editTitle", { name: source.data.name })}
        description={SOURCE_KIND_LABELS[source.data.kind]}
      />
      <SourceForm key={source.data.id} kind={source.data.kind} source={source.data} />
    </Page>
  );
}
