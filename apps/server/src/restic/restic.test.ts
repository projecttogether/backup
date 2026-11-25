import { describe, expect, it } from "vitest";
import { errorLine, redact, repositoryUrl } from "./restic";

describe("restic helpers", () => {
  it("builds the repository address", () => {
    expect(
      repositoryUrl({ endpoint: "https://fsn1.your-objectstorage.com/", bucket: "acme-backups", prefix: "" }),
    ).toBe("s3:https://fsn1.your-objectstorage.com/acme-backups");
    expect(repositoryUrl({ endpoint: "https://s3.example.org", bucket: "b", prefix: "backup/prod" })).toBe(
      "s3:https://s3.example.org/b/backup/prod",
    );
  });

  it("keeps secrets out of error messages", () => {
    expect(redact("Fatal: https://key:secret@s3.example.org failed")).toBe(
      "Fatal: https://***@s3.example.org failed",
    );
    expect(redact("password=hunter2 token: abc")).toBe("password=*** token: ***");
    expect(errorLine("repository 1234abcd opened\nFatal: wrong password or no key found\n", "x")).toBe(
      "Fatal: wrong password or no key found",
    );
    expect(errorLine("", "fallback")).toBe("fallback");
  });
});
