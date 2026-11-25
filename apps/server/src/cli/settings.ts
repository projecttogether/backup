import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { operator, type Actor } from "../auth/principal";
import { UsageError, type CliIo } from "./io";

/** One line of `cli settings list`: a setting, or one entry of a list (with its ID). */
export type SettingRow = {
  name: string;
  /** The entry's ID, for list settings (sources). */
  id?: string;
  state: "set" | "not set" | "incomplete";
  /** What the admin page shows at a glance: addresses, `secret key …a1b2`. Never a secret. */
  hints: string[];
};

export type OptionValues = Record<string, string | boolean | undefined>;

/** Options of a command beyond `--id`, with the command's syntax for error messages. */
export type ExtraOptions = { options: ParseArgsOptionsConfig; usage: string };

/**
 * What `apply` printed: the JSON that `show` prints, or text (the .env lines
 * of a new app source). `note` goes to stderr.
 */
export type Applied = { json: unknown; note?: string } | { text: string; note?: string };

/** What a test answered: the result as JSON; `message` goes to stderr, and exit 1 unless `ok`. */
export type Tested = { result: unknown; ok: boolean; message?: string };

/**
 * One setting of the admin pages for `cli settings`. Each one calls the same
 * functions as the page's routes; it adds no checks of its own.
 */
export type Setting = {
  /** Kebab-case, as on the admin pages. */
  name: string;
  /** One line for `cli help`. */
  label: string;
  /** A list of entries with IDs (`--id`), such as the sources; otherwise one setting. */
  list: boolean;
  rows(): Promise<SettingRow[]>;
  /** What the admin API's read answers: hints, never a secret. A list without `id`: every entry. */
  show(id: string | undefined): Promise<unknown>;
  /** Saves the JSON body the admin page sends (the text from stdin). A list without `id`: a new entry. */
  apply(actor: Actor, body: string, id: string | undefined): Promise<Applied>;
  /** Removes an entry of a list; answers the message for stderr. */
  remove?(actor: Actor, id: string, options: OptionValues): Promise<string>;
  removeOptions?: ExtraOptions;
  /** What the page's test button does, where it has one. */
  test?(actor: Actor, id: string | undefined, options: OptionValues): Promise<Tested>;
  testOptions?: ExtraOptions;
};

const USAGE = "cli settings list|show|apply|remove|test <name> [--id <id>]";

export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The options of a command. Messages never repeat what was typed: it could be a secret. */
export function parse(args: string[], options: ParseArgsOptionsConfig, usage: string): OptionValues {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (error) {
    const known = (error as { code?: unknown }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
    throw new UsageError(known ? `${(error as Error).message}.` : "Unknown option.", usage);
  }
  if (parsed.positionals.length > 0) {
    throw new UsageError("Too many arguments. A body goes on stdin, never in an argument.", usage);
  }
  return parsed.values as OptionValues;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An entry's ID as `cli settings list` shows it (a UUID). The message does not repeat it. */
export function entryId(value: string | boolean | undefined, usage: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new UsageError("The ID is a UUID, as cli settings list shows it.", usage);
  }
  return value.toLowerCase();
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Reads the JSON body from stdin; one that is not JSON is a usage error (exit 2). */
export async function readJsonBody(io: CliIo, usage: string): Promise<string> {
  const body = await io.readStdin();
  if (!isJson(body)) throw new UsageError("The body on stdin is not JSON.", usage);
  return body;
}

function printRows(rows: SettingRow[], io: CliIo, asJson: boolean) {
  if (asJson) {
    io.out(json(rows));
    return;
  }
  const labels = rows.map((row) => (row.id === undefined ? row.name : `${row.name} --id ${row.id}`));
  const width = Math.max(...labels.map((label) => label.length));
  for (const [index, row] of rows.entries()) {
    io.out(
      `${labels[index]!.padEnd(width)}  ${row.state.padEnd(10)}  ${row.hints.join("; ")}`.trimEnd() + "\n",
    );
  }
}

/**
 * `cli settings …`: list, show, apply, remove and test the settings of the
 * admin pages, as an operator with an admin's rights. Returns the exit code.
 */
export async function settingsCommand(args: string[], io: CliIo, settings: Setting[]): Promise<number> {
  const names = settings.map((setting) => setting.name).join(", ");
  const [command, ...rest] = args;

  if (command === "list") {
    const values = parse(rest, { json: { type: "boolean" } }, "cli settings list [--json]");
    const rows: SettingRow[] = [];
    for (const setting of settings) rows.push(...(await setting.rows()));
    printRows(rows, io, values.json === true);
    return 0;
  }

  if (command !== "show" && command !== "apply" && command !== "remove" && command !== "test") {
    throw new UsageError("Unknown command.", USAGE);
  }
  const [name, ...optionArgs] = rest;
  const usage = `cli settings ${command} <name>`;
  if (!name || name.startsWith("-")) throw new UsageError(`Name the setting: ${names}.`, usage);
  const setting = settings.find((candidate) => candidate.name === name);
  if (!setting) throw new UsageError(`Unknown setting. The settings are ${names}.`, usage);
  const idOption = { id: { type: "string" } } as const;
  const idUsage = `cli settings ${command} ${setting.name}${setting.list ? " [--id <id>]" : ""}`;
  /** The --id of a list's entry; a single setting takes none. */
  const idOf = (values: OptionValues, required: boolean, syntax = idUsage): string | undefined => {
    if (!setting.list) {
      if (values.id !== undefined)
        throw new UsageError(`${setting.name} is a single setting: leave out --id.`);
      return undefined;
    }
    if (values.id === undefined) {
      if (required) throw new UsageError(`Give the entry's --id (cli settings list shows them).`, syntax);
      return undefined;
    }
    return entryId(values.id, syntax);
  };
  /** The command for the audit log: no body, no option but the ID. */
  const as = (id: string | undefined) =>
    operator(`cli settings ${command} ${setting.name}${id === undefined ? "" : ` --id ${id}`}`);

  switch (command) {
    case "show": {
      const id = idOf(parse(optionArgs, idOption, idUsage), false);
      io.out(json(await setting.show(id)));
      return 0;
    }
    case "apply": {
      const id = idOf(parse(optionArgs, idOption, idUsage), false);
      const body = await readJsonBody(io, `${idUsage} < body.json`);
      const applied = await setting.apply(as(id), body, id);
      io.out("json" in applied ? json(applied.json) : applied.text);
      if (applied.note) io.err(`${applied.note}\n`);
      return 0;
    }
    case "remove": {
      if (!setting.remove) {
        throw new UsageError(`${setting.name} is a single setting, not a list: apply a body to change it.`);
      }
      const extra = setting.removeOptions;
      const syntax = extra?.usage ?? `cli settings remove ${setting.name} --id <id>`;
      const values = parse(optionArgs, { ...idOption, ...extra?.options }, syntax);
      const id = idOf(values, true, syntax)!;
      io.err(`${await setting.remove(as(id), id, values)}\n`);
      return 0;
    }
    case "test": {
      if (!setting.test) throw new UsageError(`${setting.name} has no test.`);
      const extra = setting.testOptions;
      const syntax = extra?.usage ?? `cli settings test ${setting.name}${setting.list ? " --id <id>" : ""}`;
      const values = parse(optionArgs, { ...idOption, ...extra?.options }, syntax);
      const id = idOf(values, setting.list, syntax);
      const tested = await setting.test(as(id), id, values);
      io.out(json(tested.result));
      if (tested.message) io.err(`${tested.message}\n`);
      return tested.ok ? 0 : 1;
    }
  }
}
