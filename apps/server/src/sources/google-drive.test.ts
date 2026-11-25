import { describe, expect, it } from "vitest";
import { folderName, parseRcloneLog, rclone, remotesOf } from "./google-drive";

const key = JSON.stringify(
  { type: "service_account", client_email: "a@b.iam.gserviceaccount.com", private_key: "x" },
  null,
  2,
);

describe("Google Drive", () => {
  it("builds one rclone remote for a shared drive, read-only, as the Workspace user", () => {
    const [remote] = remotesOf(
      { config: { subject: "backup@example.org", scope: { type: "shared_drive", driveId: "0ABCdefGHIjk" } } },
      key,
    );
    expect(remote!.target).toBe("");
    expect(remote!.env).toMatchObject({
      RCLONE_CONFIG_GDRIVE_TYPE: "drive",
      RCLONE_CONFIG_GDRIVE_SCOPE: "drive.readonly",
      RCLONE_CONFIG_GDRIVE_IMPERSONATE: "backup@example.org",
      RCLONE_CONFIG_GDRIVE_TEAM_DRIVE: "0ABCdefGHIjk",
      RCLONE_CONFIG_GDRIVE_EXPORT_FORMATS: "docx,xlsx,pptx,svg",
    });
    // The key on one line.
    expect(remote!.env.RCLONE_CONFIG_GDRIVE_SERVICE_ACCOUNT_CREDENTIALS).not.toContain("\n");
  });

  it("gives each folder its own, unique folder in the copy", () => {
    const remotes = remotesOf(
      {
        config: {
          subject: "backup@example.org",
          scope: {
            type: "folders",
            folders: [
              { id: "1aaaaaaaaaaa", label: "Finance/2026" },
              { id: "1bbbbbbbbbbb", label: "finance 2026" },
              { id: "1ccccccccccc", label: "Board" },
            ],
          },
        },
      },
      key,
    );
    expect(remotes.map((remote) => remote.target)).toEqual(["Finance 2026", "finance 2026 2", "Board"]);
    expect(remotes[2]!.env.RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID).toBe("1ccccccccccc");
  });

  it("makes folder names safe", () => {
    expect(folderName("  ../a:b*c?  ")).toBe("a b c");
    expect(folderName("\u0000x")).toBe("x");
  });

  it("tells errors about single items from rclone's summaries and from general errors", () => {
    const log = [
      '{"level":"notice","msg":"hello"}',
      '{"level":"error","msg":"Failed to copy: googleapi: Error 403: cannotDownloadFile","object":"a/b.pdf"}',
      '{"level":"error","msg":"Attempt 3/3 failed with 1 errors and: googleapi: Error 403: cannotDownloadFile"}',
      '{"level":"critical","msg":"Failed to sync: googleapi: Error 403: cannotDownloadFile"}',
      '{"level":"notice","msg":"Duplicate object found in source - ignoring","object":"Board/minutes.docx"}',
      '{"level":"critical","msg":"Failed to create file system: token https://user:secret@x invalid"}',
      '{"level":"error","msg":"error reading source root directory: googleapi: Error 403","object":"Board"}',
      // rclone 1.76 after an item error: about the copy (an Fs), not about an item.
      '{"level":"error","msg":"not deleting files as there were IO errors","object":"Local file system at /data/staging/s1","objectType":"*local.Fs"}',
      '{"level":"error","msg":"not deleting directories as there were IO errors","object":"Local file system at /data/staging/s1","objectType":"*local.Fs"}',
      "",
    ].join("\n");
    expect(parseRcloneLog(log)).toEqual({
      errors: [
        {
          message: "Failed to copy: googleapi: Error 403: cannotDownloadFile",
          object: "a/b.pdf",
          kind: "item",
        },
        {
          message: "Attempt 3/3 failed with 1 errors and: googleapi: Error 403: cannotDownloadFile",
          object: null,
          kind: "summary",
        },
        {
          message: "Failed to sync: googleapi: Error 403: cannotDownloadFile",
          object: null,
          kind: "summary",
        },
        {
          message: "Failed to create file system: token https://***@x invalid",
          object: null,
          kind: "general",
        },
        // A folder that could not be listed: its copy may be old, so the whole copy fails.
        {
          message: "error reading source root directory: googleapi: Error 403",
          object: "Board",
          kind: "general",
        },
        {
          message: "not deleting files as there were IO errors",
          object: "Local file system at /data/staging/s1",
          kind: "summary",
        },
        {
          message: "not deleting directories as there were IO errors",
          object: "Local file system at /data/staging/s1",
          kind: "summary",
        },
      ],
      duplicates: ["Board/minutes.docx"],
    });
  });

  it("starts no rclone once the run is stopped", async () => {
    // Stopped during an awaited step before: no abort event comes any more.
    await expect(rclone(["version"], {}, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });
});
