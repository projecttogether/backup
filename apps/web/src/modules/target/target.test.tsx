import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run, target } from "@/test-fixtures";
import { renderPage, requests, stubApi } from "@/test-utils";
import { TargetPage } from "./target-page";

afterEach(() => vi.unstubAllGlobals());

const missing = target({
  repository: { state: "missing", message: null, checkedAt: "2026-11-20T08:00:00.000Z", hasPassword: false },
  protection: null,
  stats: null,
  lastCheck: null,
});

describe("target page", () => {
  it("creates the repository when none is there", async () => {
    const fetch = stubApi({
      "GET /target": { body: missing },
      "POST /target/initialize": {
        body: target({ repository: { ...missing.repository, state: "ready", hasPassword: true } }),
      },
    });
    const user = userEvent.setup();
    renderPage(<TargetPage />);
    expect(await screen.findByText("No repository yet")).toBeVisible();
    expect(
      screen.getByText("The recovery kit is ready once the repository is created or connected."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect to an existing repository" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create repository" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Create the repository?" });
    expect(confirm).toHaveTextContent("generates a strong password");
    expect(confirm).toHaveTextContent("recovery kit");
    await user.click(within(confirm).getByRole("button", { name: "Create repository" }));
    await waitFor(() => expect(requests(fetch, "POST /target/initialize")).toHaveLength(1));
    expect(await screen.findByText("The repository is ready. Backups go here.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Download recovery kit" })).toHaveAttribute(
      "href",
      "/api/v1/target/recovery-kit",
    );
  });

  it("connects to an existing repository with its password", async () => {
    const wrong = target({
      repository: { ...missing.repository, state: "wrong_password", hasPassword: true },
    });
    const fetch = stubApi({
      "GET /target": { body: wrong },
      "POST /target/connect": [
        {
          status: 400,
          body: {
            error: {
              code: "validation_failed",
              message: "Wrong",
              fields: { password: "This password does not open it" },
            },
          },
        },
        { body: target() },
      ],
    });
    const user = userEvent.setup();
    renderPage(<TargetPage />);
    expect(await screen.findByText("Wrong password")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Connect to an existing repository" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect to an existing repository" });
    const password = within(dialog).getByLabelText("Repository password");
    expect(password).toHaveAttribute("type", "password");
    await user.type(password, "old secret");
    await user.click(within(dialog).getByRole("button", { name: "Show" }));
    expect(password).toHaveAttribute("type", "text");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByText("This password does not open it")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests(fetch, "POST /target/connect").map((request) => request.body)).toEqual([
      { password: "old secret" },
      { password: "old secret" },
    ]);
    expect(await screen.findByText("Ready")).toBeVisible();
  });

  it("shows a ready repository with its protection, and confirms the stored recovery kit", async () => {
    const fetch = stubApi({
      "GET /target": { body: target() },
      "POST /target/recovery-kit/confirm": {
        body: target({ recoveryKitConfirmedAt: "2026-11-20T09:00:00.000Z" }),
      },
    });
    const user = userEvent.setup();
    renderPage(<TargetPage />);
    expect(await screen.findByText("Ready")).toBeVisible();
    expect(screen.getByText("s3:https://fsn1.your-objectstorage.com/acme-backups")).toBeVisible();
    expect(screen.getByText("On (Compliance, 30 days)")).toBeVisible();
    expect(screen.queryByText(/In governance mode/)).not.toBeInTheDocument();
    expect(screen.getByText("Old versions deleted after 31 days")).toBeVisible();
    expect(screen.getByText("Read and verified 5% of the data")).toBeVisible();
    expect(screen.getByText("42 GB")).toBeVisible();
    expect(
      screen.queryByText(/Object Lock must be enabled when the bucket is created/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Not stored yet")).toBeVisible();
    expect(screen.getByText(/the plain restic command line restores everything/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "I stored the recovery kit" }));
    await waitFor(() => expect(requests(fetch, "POST /target/recovery-kit/confirm")).toHaveLength(1));
    expect(await screen.findByText("Stored")).toBeVisible();
    expect(screen.queryByRole("button", { name: "I stored the recovery kit" })).not.toBeInTheDocument();
  });

  it("says that governance mode can be bypassed", async () => {
    const ready = target();
    stubApi({
      "GET /target": {
        body: target({
          protection: {
            ...ready.protection!,
            objectLock: { enabled: true, mode: "GOVERNANCE", days: 30 },
          },
        }),
      },
    });
    renderPage(<TargetPage />);
    expect(await screen.findByText("On (Governance, 30 days)")).toBeVisible();
    expect(
      screen.getByText(
        "In governance mode, a key with the bypass permission can delete locked data early. Compliance mode lets nobody do that.",
      ),
    ).toBeVisible();
  });

  it("recommends what the bucket lacks", async () => {
    stubApi({
      "GET /target": {
        body: target({
          protection: {
            checkedAt: "2026-11-20T08:00:00.000Z",
            versioning: "off",
            objectLock: { enabled: false, mode: null, days: null },
            lifecycle: { noncurrentDays: null, expiredDeleteMarkers: false, abortMultipartDays: null },
            error: null,
          },
        }),
      },
    });
    renderPage(<TargetPage />);
    expect(await screen.findByText(/Object Lock must be enabled when the bucket is created/)).toBeVisible();
    expect(screen.getByText(/Turn on versioning/)).toBeVisible();
    const command = screen.getByText(/aws s3api put-bucket-lifecycle-configuration/);
    expect(command).toHaveTextContent("--bucket acme-backups");
    expect(command).toHaveTextContent("--region fsn1");
    // The rules are in the command itself, as valid JSON: it runs as shown.
    const rules = /--lifecycle-configuration '([^']+)'/.exec(command.textContent ?? "")?.[1];
    expect(JSON.parse(rules ?? "null")).toEqual({
      Rules: [
        {
          ID: "old-versions",
          Status: "Enabled",
          Filter: { Prefix: "" },
          NoncurrentVersionExpiration: { NoncurrentDays: 31 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
        },
        {
          ID: "delete-markers",
          Status: "Enabled",
          Filter: { Prefix: "" },
          Expiration: { ExpiredObjectDeleteMarker: true },
        },
      ],
    });
  });

  it("saves the bucket, keeping the stored secret key", async () => {
    const fetch = stubApi({ "GET /target": { body: target() }, "PUT /target": { body: target() } });
    const user = userEvent.setup();
    renderPage(<TargetPage />);
    const prefix = await screen.findByLabelText("Folder in the bucket");
    await user.type(prefix, "acme/backups");
    expect(screen.getByText("Stored (…9f2a)")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests(fetch, "PUT /target")).toHaveLength(1));
    expect(requests(fetch, "PUT /target")[0]!.body).toEqual({
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      bucket: "acme-backups",
      prefix: "acme/backups",
      accessKeyId: "AKIA123",
    });
  });

  it("runs the upkeep now and links to the run", async () => {
    const fetch = stubApi({
      "GET /target": { body: target() },
      "POST /maintenance/run": { status: 202, body: run({ kind: "maintenance", status: "queued" }) },
    });
    const user = userEvent.setup();
    renderPage(<TargetPage />);
    expect(await screen.findByLabelText("Daily at")).toHaveValue("03:00");
    await user.click(screen.getByRole("button", { name: "Run upkeep now" }));
    await waitFor(() => expect(requests(fetch, "POST /maintenance/run")).toHaveLength(1));
    expect(await screen.findByRole("link", { name: "View run" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/runs\//),
    );
  });
});
