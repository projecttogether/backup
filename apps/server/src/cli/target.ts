import type { Target } from "@backup/shared/api/target";
import { maintenanceInputSchema, targetConnectSchema, targetInputSchema } from "@backup/shared/api/target";
import { operator } from "../auth/principal";
import { config } from "../config";
import { readSetting } from "../core/settings";
import { getDb } from "../db/client";
import { parseJsonBody } from "../http/json";
import {
  MAINTENANCE_KEY,
  confirmRecoveryKit,
  connectTarget,
  downloadRecoveryKit,
  initializeTarget,
  maintenanceTime,
  saveMaintenance,
  saveTarget,
  targetView,
  testTarget,
} from "../target/target";
import { UsageError, type CliIo } from "./io";
import { json, parse, readJsonBody, type Setting, type Tested } from "./settings";

/** What the Target page says about the repository's state, and whether a test found a problem. */
function verdict(view: Target): Omit<Tested, "result"> {
  const { state, message, hasPassword } = view.repository;
  if (state === "ready") return { ok: true, message: "The repository is ready. Backups go here." };
  if (state === "error") return { ok: false, message: message ?? "Cannot reach the bucket" };
  if (state === "missing" && !hasPassword) {
    return {
      ok: true,
      message:
        "There is no repository at this address yet. Create one (cli target initialize), or connect to one that exists there (cli target connect).",
    };
  }
  if (state === "missing") return { ok: false, message: "The repository is gone from this address." };
  if (state === "wrong_password" && !hasPassword) {
    return { ok: true, message: `${message ?? "A repository exists here."} (cli target connect)` };
  }
  if (state === "wrong_password") {
    return {
      ok: false,
      message:
        "A repository is there, but the stored password does not open it. Enter the repository's password (cli target connect).",
    };
  }
  return { ok: false, message: "Not checked yet" };
}

/** `target`: the bucket and its keys (Target page, PUT /api/v1/target). */
export const target: Setting = {
  name: "target",
  label: "the bucket and its keys (Target)",
  list: false,
  async rows() {
    const view = await targetView(getDb());
    if (!view.configured) return [{ name: "target", state: "not set", hints: [] }];
    return [
      {
        name: "target",
        state: view.repository.hasPassword ? "set" : "incomplete",
        hints: [
          view.repositoryUrl!,
          `access key ${view.accessKeyId}`,
          `secret key ${view.secretAccessKeyHint}`,
          view.repository.hasPassword ? `repository ${view.repository.state}` : "no repository yet",
          ...(view.repository.hasPassword
            ? [view.recoveryKitConfirmedAt ? "recovery kit stored" : "recovery kit not stored yet"]
            : []),
        ],
      },
    ];
  },
  show: () => targetView(getDb()),
  async apply(actor, body) {
    await saveTarget(getDb(), parseJsonBody(body, targetInputSchema), actor);
    return { json: await targetView(getDb()) };
  },
  async test() {
    await testTarget(getDb());
    const view = await targetView(getDb());
    return { result: view, ...verdict(view) };
  },
};

const maintenanceView = async () => ({
  maintenanceTime: await maintenanceTime(getDb()),
  timezone: config().TZ,
});

/** `maintenance`: the time of the daily upkeep (Target page, PUT /api/v1/target/maintenance). */
export const maintenance: Setting = {
  name: "maintenance",
  label: "the time of the daily upkeep (Target › Upkeep)",
  list: false,
  async rows() {
    const view = await maintenanceView();
    const saved = await readSetting(getDb(), MAINTENANCE_KEY);
    return [
      {
        name: "maintenance",
        state: saved ? "set" : "not set",
        hints: [`daily at ${view.maintenanceTime}${saved ? "" : " (the default)"}, ${view.timezone}`],
      },
    ];
  },
  show: () => maintenanceView(),
  async apply(actor, body) {
    await saveMaintenance(getDb(), parseJsonBody(body, maintenanceInputSchema), actor);
    return { json: await maintenanceView() };
  },
};

const TARGET_USAGE = "cli target initialize|connect|recovery-kit|confirm-recovery-kit";

/**
 * `cli target …`: the Target page's buttons for the repository and the
 * recovery kit, as the operator. Returns the exit code.
 */
export async function targetCommand(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  const db = getDb();
  switch (command) {
    case "initialize": {
      parse(rest, {}, "cli target initialize");
      await initializeTarget(db, operator("cli target initialize"));
      io.out(json(await targetView(db)));
      io.err(
        "Created the repository. Write the recovery kit now and store it offline: (umask 077; set -C; cli target recovery-kit > recovery-kit.txt)\n",
      );
      return 0;
    }
    case "connect": {
      const usage = "cli target connect < password.json";
      parse(rest, {}, usage);
      const { password } = parseJsonBody(await readJsonBody(io, usage), targetConnectSchema);
      await connectTarget(db, password, operator("cli target connect"));
      io.out(json(await targetView(db)));
      io.err("Connected the repository.\n");
      return 0;
    }
    case "recovery-kit": {
      const usage = "(umask 077; set -C; cli target recovery-kit > recovery-kit.txt)";
      parse(rest, {}, usage);
      if (io.stdoutIsTerminal) {
        throw new UsageError(
          "The recovery kit holds the repository password and the bucket's keys: redirect it into a file.",
          usage,
        );
      }
      io.out(await downloadRecoveryKit(db, operator("cli target recovery-kit")));
      io.err(
        "Wrote the recovery kit. Store it offline, delete this copy, then: cli target confirm-recovery-kit\n",
      );
      return 0;
    }
    case "confirm-recovery-kit": {
      parse(rest, {}, "cli target confirm-recovery-kit");
      await confirmRecoveryKit(db, operator("cli target confirm-recovery-kit"));
      io.out(json(await targetView(db)));
      io.err("Recorded that the recovery kit is stored.\n");
      return 0;
    }
    default:
      throw new UsageError(command ? "Unknown command." : "Name a command.", TARGET_USAGE);
  }
}
