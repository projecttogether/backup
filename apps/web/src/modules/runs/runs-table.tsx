import { Link } from "@tanstack/react-router";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Run } from "@backup/shared/api/runs";
import { RunStatusBadge } from "@/components/status";
import { When } from "@/components/when";
import { useT } from "@/i18n";
import { useFormatter } from "@/lib/format";
import { runDuration } from "./api";
import { messages } from "./messages";

/** Runs in a table that scrolls sideways on small screens; each links to its page. */
export function RunsTable({ runs, label }: { runs: Run[]; label?: string }) {
  const t = useT(messages);
  const format = useFormatter();
  return (
    <Table scrollLabel={label ?? t("runsTable")}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("colStatus")}</TableHead>
          <TableHead>{t("colWhat")}</TableHead>
          <TableHead>{t("colTrigger")}</TableHead>
          <TableHead>{t("colStarted")}</TableHead>
          <TableHead>{t("colDuration")}</TableHead>
          <TableHead className="text-right">{t("colAdded")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const duration = runDuration(run);
          return (
            <TableRow key={run.id}>
              <TableCell>
                <RunStatusBadge status={run.status} sourceKind={run.sourceKind} />
              </TableCell>
              <TableCell className="font-medium">
                <Link
                  to="/runs/$id"
                  params={{ id: run.id }}
                  className="text-link underline-offset-4 hover:underline"
                >
                  {run.sourceName}
                </Link>
                {run.kind !== "backup" ? (
                  <div className="text-muted-foreground text-xs font-normal">{t(run.kind)}</div>
                ) : null}
              </TableCell>
              <TableCell>{t(run.trigger)}</TableCell>
              <TableCell>
                <When value={run.startedAt ?? run.queuedAt} />
              </TableCell>
              <TableCell>
                {duration === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  format.duration(duration)
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {run.stats?.bytesAdded != null ? (
                  format.bytes(run.stats.bytesAdded)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
