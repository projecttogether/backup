import { Link } from "@tanstack/react-router";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SOURCE_KIND_LABELS, type Source } from "@backup/shared/api/sources";
import { SourceStatusBadge } from "@/components/status";
import { When } from "@/components/when";
import { useT } from "@/i18n";
import { useFormatter } from "@/lib/format";
import { messages } from "./messages";
import { BackUpNowButton, useScheduleText } from "./parts";

/** Sources with their state; scrolls sideways on small screens. */
export function SourcesTable({ sources, showSchedule }: { sources: Source[]; showSchedule?: boolean }) {
  const t = useT(messages);
  const format = useFormatter();
  const scheduleText = useScheduleText();
  return (
    <Table scrollLabel={t("sourcesTable")}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("colName")}</TableHead>
          <TableHead>{t("colKind")}</TableHead>
          <TableHead>{t("colStatus")}</TableHead>
          {showSchedule ? <TableHead>{t("colSchedule")}</TableHead> : null}
          <TableHead>{t("colLastSuccess")}</TableHead>
          <TableHead className="text-right">{t("colSize")}</TableHead>
          <TableHead>{t("colNextRun")}</TableHead>
          <TableHead>
            <span className="sr-only">{t("colActions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sources.map((source) => (
          <TableRow key={source.id}>
            <TableCell className="font-medium">
              <Link
                to="/sources/$id"
                params={{ id: source.id }}
                className="text-link underline-offset-4 hover:underline"
              >
                {source.name}
              </Link>
            </TableCell>
            <TableCell>{SOURCE_KIND_LABELS[source.kind]}</TableCell>
            <TableCell>
              <SourceStatusBadge status={source.status} kind={source.kind} />
            </TableCell>
            {showSchedule ? <TableCell>{scheduleText(source.schedule)}</TableCell> : null}
            <TableCell>
              <When value={source.lastSuccessAt} empty={t("none")} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {source.lastSnapshot?.bytes != null ? (
                format.bytes(source.lastSnapshot.bytes)
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell>
              <When value={source.enabled ? source.nextRunAt : null} empty={t("notScheduled")} />
            </TableCell>
            <TableCell className="text-right">
              <BackUpNowButton source={source} size="sm" variant="outline" named />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
