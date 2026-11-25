import { afterEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";
import { logger } from "../logger";
import { target } from "./target";
import { runCli } from "./main";

const SECRET = "s3-secret-query-parameter-3e8a";

async function list() {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["settings", "list"], {
    readStdin: async () => "",
    out: (text) => void (stdout += text),
    err: (text) => void (stderr += text),
    stdoutIsTerminal: false,
  });
  return { code, stdout, stderr };
}

afterEach(() => vi.restoreAllMocks());

describe("a database error", () => {
  it("prints the page's generic message, never the query's values", async () => {
    const cause = Object.assign(new pg.DatabaseError(`value "${SECRET}" is too long`, 0, "error"), {
      code: "22001",
    });
    vi.spyOn(target, "rows").mockRejectedValue(
      new DrizzleQueryError("update settings set value = $1", [SECRET], cause),
    );
    expect(await list()).toEqual({
      code: 1,
      stdout: "",
      stderr: "Something went wrong. Try again. (database error 22001)\n",
    });

    vi.spyOn(target, "rows").mockRejectedValue(cause);
    expect((await list()).stderr).toBe("Something went wrong. Try again. (database error 22001)\n");
  });

  it("says that someone else changed the setting at the same time", async () => {
    const cause = Object.assign(new pg.DatabaseError("deadlock detected", 0, "error"), { code: "40P01" });
    vi.spyOn(target, "rows").mockRejectedValue(cause);
    expect(await list()).toEqual({
      code: 1,
      stdout: "",
      stderr: "Someone else changed this at the same time. Try again.\n",
    });
  });
});

describe("another error", () => {
  it("is logged, not taken for a database error because its code has five characters", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    vi.spyOn(target, "rows").mockRejectedValue(error);
    expect(await list()).toEqual({ code: 1, stdout: "", stderr: "Something went wrong. Try again.\n" });
    expect(logged).toHaveBeenCalledWith({ err: error }, "command failed");
  });
});
