import { ZodError } from "zod";
import { AppError, CONCURRENT_CHANGE_CODES, databaseErrorCode, zodFieldErrors } from "../http/errors";
import { logger } from "../logger";
import { UsageError, type CliIo } from "./io";
import { notifications } from "./notifications";
import { settingsCommand, type Setting } from "./settings";
import { sources, sourcesCommand, tokensCommand } from "./sources";
import { maintenance, target, targetCommand } from "./target";

/** The settings of the admin pages, in the order of the sidebar. */
export const SETTINGS: Setting[] = [target, maintenance, sources, notifications];

const DOCS =
  "https://github.com/projecttogether/backup/blob/main/docs/deployment.md#settings-from-the-command-line";

function help(): string {
  const width = Math.max(...SETTINGS.map((setting) => setting.name.length));
  return `Backup: the operator command. On a server with compose.yaml:
  docker compose run --rm -T migrate cli <command>
In a terminal of the app's container: cli <command>

Settings:
  cli settings list [--json]                       every setting and source: set, not set or incomplete, with hints
  cli settings show <name> [--id <id>]             the setting as JSON, as the admin page reads it
  cli settings apply <name> [--id <id>] < body.json
                                                   save the admin page's JSON body from stdin;
                                                   sources without --id: add a source
  cli settings remove sources --id <id> [--snapshots keep|forget]
  cli settings test <name> [--id <id>]             what the page's test button does
  cli settings test notifications --email|--heartbeat

Target:
  cli target initialize                            create the restic repository, with a new password
  cli target connect < password.json               use an existing repository: {"password": "…"}
  (umask 077; set -C; cli target recovery-kit > recovery-kit.txt)
                                                   write the recovery kit into a new private file
  cli target confirm-recovery-kit                  record that the recovery kit is stored offline

Sources and tokens:
  cli sources run <id>                             back up a source now
  cli tokens create agent --source <id>            a new agent token for an app source (alone on stdout)

  cli help                                         this text

Setting names:
${SETTINGS.map((setting) => `  ${setting.name.padEnd(width)}  ${setting.label}`).join("\n")}

Secrets go only on stdin, never in an argument; output shows hints only.
Adding an app source prints BACKUP_URL and BACKUP_TOKEN once, for the app's .env.
Run what prints a secret (that, a new token, the recovery kit) with
docker compose exec -T web cli …: Docker logs what a container started with "run" prints.
Exit codes: 0 done, 1 refused (the page's message on stderr), 2 wrong command
or a body that is not JSON. Example bodies: ${DOCS}
`;
}

/**
 * What went wrong, for stderr, with the page's messages. A database error
 * gets the page's generic message: its text can quote values, and a failed
 * query carries its parameters.
 */
function report(error: unknown, io: CliIo): number {
  if (error instanceof UsageError) {
    io.err(
      `${error.message}\n${error.usage ? `Usage: ${error.usage}\n` : ""}Run "cli help" for the commands.\n`,
    );
    return 2;
  }
  if (error instanceof AppError || error instanceof ZodError) {
    const [message, fields] =
      error instanceof AppError
        ? [error.message, error.fields]
        : ["Check the highlighted fields", zodFieldErrors(error)];
    io.err(`${message}\n`);
    for (const [field, text] of Object.entries(fields ?? {})) io.err(`  ${field}: ${text}\n`);
    return 1;
  }
  const code = databaseErrorCode(error);
  if (code && CONCURRENT_CHANGE_CODES.has(code)) {
    io.err("Someone else changed this at the same time. Try again.\n");
    return 1;
  }
  // A SQLSTATE, not a Node.js code such as EPERM: no SQLSTATE starts with E.
  if (code && /^(?!E)[0-9A-Z]{5}$/.test(code)) {
    io.err(`Something went wrong. Try again. (database error ${code})\n`);
    return 1;
  }
  logger.error({ err: error }, "command failed");
  io.err("Something went wrong. Try again.\n");
  return 1;
}

/** Runs `cli <args>` and returns the exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  try {
    const [command, ...rest] = args;
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        if (rest.length > 0) throw new UsageError("help takes no arguments.");
        io.out(help());
        return 0;
      case "settings":
        return await settingsCommand(rest, io, SETTINGS);
      case "target":
        return await targetCommand(rest, io);
      case "sources":
        return await sourcesCommand(rest, io);
      case "tokens":
        return await tokensCommand(rest, io);
      case undefined:
        io.err(help());
        return 2;
      default:
        throw new UsageError("Unknown command.");
    }
  } catch (error) {
    return report(error, io);
  }
}
