import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentInfo, appSource, driveSource, IDS, run, s3Source } from "@/test-fixtures";
import { renderPage, requests, stubApi } from "@/test-utils";
import { SourcePage } from "./source-page";

afterEach(() => vi.unstubAllGlobals());

const SNAPSHOTS = {
  items: [
    { id: "a1b2c3d4e5f60718", time: "2026-11-19T02:00:00.000Z", bytes: 2048, files: 10 },
    { id: "b1b2c3d4e5f60718", time: "2026-11-20T02:00:00.000Z", bytes: 3 * 1024 ** 2, files: 12 },
  ],
};

function stubSource(source = driveSource(), extra: Parameters<typeof stubApi>[0] = {}) {
  return stubApi({
    [`GET /sources/${source.id}`]: { body: source },
    [`GET /sources/${source.id}/snapshots`]: { body: SNAPSHOTS },
    "GET /runs": { body: { items: [run({ sourceId: source.id, sourceName: source.name })], total: 1 } },
    ...extra,
  });
}

describe("source page", () => {
  it("shows the schedule, snapshots with download links, and recent runs", async () => {
    const fetch = stubSource();
    renderPage(<SourcePage id={IDS.drive} />);
    expect(await screen.findByRole("heading", { name: "Team drive" })).toBeInTheDocument();
    expect(screen.getByText("Daily at 02:00")).toBeVisible();
    expect(
      screen.getByText(
        "With these numbers: the newest snapshot of each of the last 14 days, 8 weeks, and 12 months.",
      ),
    ).toBeVisible();
    const table = await screen.findByRole("region", { name: "Snapshots" });
    const rows = within(table).getAllByRole("row");
    // Newest first, each as a zip for Google Drive.
    expect(rows[1]).toHaveTextContent("3 MB");
    expect(within(rows[1]!).getByRole("link", { name: /as zip$/ })).toHaveAttribute(
      "href",
      `/api/v1/sources/${IDS.drive}/snapshots/b1b2c3d4e5f60718/download`,
    );
    expect(await screen.findByRole("region", { name: "Runs" })).toBeInTheDocument();
    expect(requests(fetch, "GET /runs")[0]!.url).toContain(`sourceId=${IDS.drive}`);
  });

  it("backs up now and leads to the run", async () => {
    const fetch = stubSource(driveSource(), {
      [`POST /sources/${IDS.drive}/run`]: { status: 202, body: run({ status: "queued" }) },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<SourcePage id={IDS.drive} />);
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(requests(fetch, `POST /sources/${IDS.drive}/run`)).toHaveLength(1));
    expect(await screen.findByText("Backup started")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "View run" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${IDS.run}`));
  });

  it("tests the source and shows what it found", async () => {
    stubSource(driveSource(), {
      [`POST /sources/${IDS.drive}/test`]: {
        body: {
          ok: true,
          message: "The service account sees the drive.",
          items: 1234,
          bytes: 5 * 1024 ** 3,
          freeBytes: 80 * 1024 ** 3,
        },
      },
    });
    const user = userEvent.setup();
    renderPage(<SourcePage id={IDS.drive} />);
    await user.click(await screen.findByRole("button", { name: "Test" }));
    const result = await screen.findByText("Test passed");
    const alert = result.closest("[role=status]")!;
    expect(alert).toHaveTextContent("The service account sees the drive.");
    expect(alert).toHaveTextContent("Items found: 1,234");
    expect(alert).toHaveTextContent("Size: 5 GB");
    expect(alert).toHaveTextContent("Free space for the local copy: 80 GB");
  });

  it("pauses with the current settings and without secrets", async () => {
    const fetch = stubSource(driveSource(), {
      [`PUT /sources/${IDS.drive}`]: { body: driveSource({ enabled: false, status: "paused" }) },
    });
    const user = userEvent.setup();
    renderPage(<SourcePage id={IDS.drive} />);
    await user.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(requests(fetch, `PUT /sources/${IDS.drive}`)).toHaveLength(1));
    expect(requests(fetch, `PUT /sources/${IDS.drive}`)[0]!.body).toEqual({
      kind: "google_drive",
      name: "Team drive",
      enabled: false,
      schedule: { type: "daily", time: "02:00" },
      retention: { daily: 14, weekly: 8, monthly: 12, yearly: 0 },
      config: {
        subject: "backup@example.org",
        scope: { type: "shared_drive", driveId: "0AbCdEfGhIjKlMnOp" },
      },
    });
    expect(await screen.findByRole("button", { name: "Resume" })).toBeVisible();
  });

  it("deletes the source and forgets its snapshots when asked", async () => {
    const fetch = stubSource(driveSource(), { [`DELETE /sources/${IDS.drive}`]: { status: 204 } });
    const user = userEvent.setup();
    const { router } = renderPage(<SourcePage id={IDS.drive} />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Team drive?" });
    expect(within(dialog).getByRole("radio", { name: "Keep its snapshots in the repository" })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: "Forget its snapshots" }));
    expect(dialog).toHaveTextContent("Forget removes them at the next upkeep; this cannot be undone.");
    await user.click(within(dialog).getByRole("button", { name: "Delete source" }));
    await waitFor(() => expect(requests(fetch, `DELETE /sources/${IDS.drive}`)).toHaveLength(1));
    expect(requests(fetch, `DELETE /sources/${IDS.drive}`)[0]!.url).toContain("snapshots=forget");
    await waitFor(() => expect(router.state.location.pathname).toBe("/sources"));
  });

  it("explains the agent's setup until it checks in, and makes a new token after asking", async () => {
    const source = appSource({
      status: "never",
      agent: agentInfo({
        lastSeenAt: null,
        version: null,
        appName: null,
        appImage: null,
        database: null,
        volumes: [],
        tokenHint: null,
      }),
    });
    const fetch = stubSource(source, {
      [`POST /sources/${IDS.app}/token`]: { body: { token: "bkp_new" } },
    });
    const user = userEvent.setup();
    renderPage(<SourcePage id={IDS.app} />);
    expect(await screen.findByText("Not seen yet")).toBeVisible();
    expect(screen.getByText(/Run the backup agent next to the app/)).toBeVisible();
    await user.click(screen.getAllByRole("button", { name: "New token" })[0]!);
    const confirm = await screen.findByRole("alertdialog", { name: "Create a new agent token?" });
    expect(requests(fetch, `POST /sources/${IDS.app}/token`)).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect the app's backup agent" });
    expect(within(dialog).getByLabelText("Agent token")).toHaveValue("bkp_new");
    expect(within(dialog).getByLabelText("Agent token")).toHaveAttribute("type", "password");
    expect(within(dialog).getByLabelText("Lines for the .env file")).toHaveTextContent(
      "BACKUP_TOKEN=••••••••",
    );
  });

  it("shows what the agent reported", async () => {
    stubSource(appSource());
    renderPage(<SourcePage id={IDS.app} />);
    expect(await screen.findByText("ghcr.io/example/wiki:1.4.0")).toBeVisible();
    expect(screen.getByText("ends in x9Yz")).toBeVisible();
    expect(screen.queryByText(/Keep apart from the backups/)).not.toBeInTheDocument();
    expect(await screen.findAllByRole("link", { name: /as tar$/ })).toHaveLength(2);
  });

  it("names the app's settings that a restore needs", async () => {
    stubSource(appSource({ agent: agentInfo({ secrets: ["AUTH_SECRET", "ENCRYPTION_KEY"] }) }));
    renderPage(<SourcePage id={IDS.app} />);
    expect(
      await screen.findByText(
        "Keep apart from the backups: AUTH_SECRET, ENCRYPTION_KEY. A restore needs them from the app's .env; the backups do not hold them.",
      ),
    ).toBeVisible();
  });

  it("shows an S3 bucket source's bucket and folder", async () => {
    stubSource(s3Source());
    renderPage(<SourcePage id={IDS.s3} />);
    expect(await screen.findByText("acme-media/originals")).toBeVisible();
    expect(screen.getByText("https://fsn1.your-objectstorage.com")).toBeVisible();
  });
});
