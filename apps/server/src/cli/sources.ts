import type { Schedule } from "@backup/shared/api/schedule";
import {
  SOURCE_KIND_LABELS,
  sourceDeleteQuerySchema,
  sourceInputSchema,
  type Source,
} from "@backup/shared/api/sources";
import { operator } from "../auth/principal";
import { config } from "../config";
import { getDb } from "../db/client";
import { parseWith } from "../http/errors";
import { parseJsonBody } from "../http/json";
import { runView } from "../runs/service";
import { deleteSource, startBackup, testSource } from "../sources/manage";
import {
  createSource,
  getSourceRow,
  listSourceRows,
  rotateAgentToken,
  sourceView,
  sourceViews,
  updateSource,
} from "../sources/service";
import { UsageError, type CliIo } from "./io";
import { entryId, json, parse, type Setting, type SettingRow } from "./settings";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function scheduleText(schedule: Schedule): string {
  if (schedule.type === "hourly") {
    return `every ${schedule.every} h at :${String(schedule.minute).padStart(2, "0")}`;
  }
  return schedule.type === "daily"
    ? `daily at ${schedule.time}`
    : `${DAYS[schedule.day]}s at ${schedule.time}`;
}

/** What the source pages show at a glance; never a secret. */
function row(source: Source): SettingRow {
  const hints = [
    `${SOURCE_KIND_LABELS[source.kind]} "${source.name}"`,
    source.enabled ? scheduleText(source.schedule) : "paused",
    `status ${source.status}`,
  ];
  if (source.kind === "app") {
    if (source.agent.tokenHint) hints.push(`token ${source.agent.tokenHint}`);
    hints.push(source.agent.lastSeenAt ? `agent seen ${source.agent.lastSeenAt}` : "agent not seen yet");
  } else if (source.kind === "google_drive") {
    hints.push(`as ${source.config.subject}`);
    if (source.config.serviceAccountEmail) hints.push(`service account ${source.config.serviceAccountEmail}`);
  } else if (source.kind === "personio") {
    hints.push(`client ${source.config.clientId}`);
    if (source.config.clientSecretHint) hints.push(`secret ${source.config.clientSecretHint}`);
  } else {
    const { endpoint, bucket, prefix } = source.config;
    hints.push(
      `${endpoint}/${bucket}${prefix ? `/${prefix}` : ""}`,
      `access key ${source.config.accessKeyId}`,
    );
    if (source.config.secretAccessKeyHint) hints.push(`secret key ${source.config.secretAccessKeyHint}`);
  }
  // An app source is set up once its agent has asked: the other app's .env has the token.
  const incomplete = source.kind === "app" && !source.agent.lastSeenAt;
  return { name: "sources", id: source.id, state: incomplete ? "incomplete" : "set", hints };
}

/** The two lines of the app server's .env, as the page shows them once (with this app's APP_URL). */
const envLines = (token: string) => `BACKUP_URL=${config().APP_URL}\nBACKUP_TOKEN=${token}\n`;

const REMOVE_USAGE = "cli settings remove sources --id <id> [--snapshots keep|forget]";

/** `sources`: what is backed up, a list (Sources pages, /api/v1/sources). */
export const sources: Setting = {
  name: "sources",
  label: "what is backed up, one entry per source (Sources)",
  list: true,
  async rows() {
    const db = getDb();
    const views = await sourceViews(db, await listSourceRows(db));
    if (views.length === 0) return [{ name: "sources", state: "not set", hints: ["no sources"] }];
    return views.map(row);
  },
  async show(id) {
    const db = getDb();
    return id === undefined ? { items: await sourceViews(db, await listSourceRows(db)) } : sourceView(db, id);
  },
  async apply(actor, body, id) {
    const db = getDb();
    const input = parseJsonBody(body, sourceInputSchema);
    if (id !== undefined) {
      await updateSource(db, id, input, actor);
      return { json: await sourceView(db, id) };
    }
    const created = await createSource(db, input, actor);
    const note = `Added the source ${created.row.name}. ID: ${created.row.id}`;
    if (created.token === null) return { json: await sourceView(db, created.row.id), note };
    // The token is shown once, as on the page: alone with BACKUP_URL on stdout, for the app's .env.
    return {
      text: envLines(created.token),
      note: `${note}\nThe two lines go into the .env of the app's server; the token is not shown again.`,
    };
  },
  removeOptions: { options: { snapshots: { type: "string" } }, usage: REMOVE_USAGE },
  async remove(actor, id, options) {
    const { snapshots } = parseWith(sourceDeleteQuerySchema, { snapshots: options.snapshots });
    const deleted = await deleteSource(getDb(), id, snapshots, actor);
    return snapshots === "forget"
      ? `Deleted the source ${deleted.name}; the next upkeep forgets its snapshots.`
      : `Deleted the source ${deleted.name}; its snapshots stay in the repository.`;
  },
  async test(_actor, id) {
    const result = await testSource(getDb(), id!);
    return { result, ok: result.ok, message: result.ok ? undefined : result.message };
  },
};

/** `cli sources run <id>`: the page's "Back up now". Returns the exit code. */
export async function sourcesCommand(args: string[], io: CliIo): Promise<number> {
  const [command, value, ...rest] = args;
  const usage = "cli sources run <id>";
  if (command !== "run") throw new UsageError(command ? "Unknown command." : "Name a command.", usage);
  parse(rest, {}, usage);
  const id = entryId(value, usage);
  const db = getDb();
  const { row: source, run, started } = await startBackup(db, id, operator(`cli sources run ${id}`));
  io.out(json(runView(run, source.name, source.kind)));
  io.err(
    started
      ? `Queued a backup of ${source.name}. Run ID: ${run.id}\n`
      : `A backup of ${source.name} is ${run.status} already. Run ID: ${run.id}\n`,
  );
  return 0;
}

export const TOKEN_KINDS = ["agent"] as const;

/**
 * `cli tokens create agent --source <id>`: a new agent token for an app
 * source, as the source page's "New token". The token alone goes to stdout,
 * so that `> file` keeps only the token. Returns the exit code.
 */
export async function tokensCommand(args: string[], io: CliIo): Promise<number> {
  const [command, kind, ...rest] = args;
  const usage = "cli tokens create agent --source <id>";
  if (command !== "create") throw new UsageError(command ? "Unknown command." : "Name a command.", usage);
  if (kind === undefined || kind.startsWith("-"))
    throw new UsageError(`Name a kind: ${TOKEN_KINDS.join(", ")}.`, usage);
  if (!(TOKEN_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(`Unknown kind. Kinds: ${TOKEN_KINDS.join(", ")}.`, usage);
  }
  const values = parse(rest, { source: { type: "string" } }, usage);
  if (values.source === undefined) throw new UsageError("Name the app source with --source <id>.", usage);
  const id = entryId(values.source, usage);
  const db = getDb();
  const token = await rotateAgentToken(db, id, operator(`cli tokens create agent --source ${id}`));
  const source = await getSourceRow(db, id);
  io.out(`${token}\n`);
  io.err(
    `Issued a new agent token for ${source.name}; the old one stops working now. ` +
      `In the .env of the app's server: BACKUP_URL=${config().APP_URL} and BACKUP_TOKEN=<this token>.\n`,
  );
  return 0;
}
