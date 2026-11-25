import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { openRepository } from "../target/target";
import { createUser, resetDatabase, setUpTarget } from "../test/helpers";
import { listSnapshots, startStreamBackup } from "./restic";

describe("a stream backup", () => {
  beforeEach(resetDatabase);

  it("saves no snapshot when it is stopped before the end, whatever it read", async () => {
    await setUpTarget(await createUser());
    const repository = await openRepository(getDb());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const backup = await startStreamBackup(repository, { tag: "source:aborted", filename: "backup.tar" });
      await backup.write(Buffer.alloc(256 * 1024, attempt));
      backup.abort();
      await backup.ended;
    }
    expect(await listSnapshots(repository, "source:aborted")).toEqual([]);

    const complete = await startStreamBackup(repository, { tag: "source:complete", filename: "backup.tar" });
    await complete.write(Buffer.alloc(1024, 1));
    const result = await complete.finish();
    expect(result.snapshotId).toMatch(/^[0-9a-f]{64}$/);
  });
});
