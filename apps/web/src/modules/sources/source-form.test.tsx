import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appSource, driveSource, IDS, personioSource, s3Source, target } from "@/test-fixtures";
import { renderPage, requests, stubApi } from "@/test-utils";
import { EditSourcePage, NewSourcePage } from "./source-form-page";

afterEach(() => vi.unstubAllGlobals());

const TOKEN = "bkp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

describe("source form", () => {
  it("offers the kinds first", async () => {
    stubApi({});
    renderPage(<NewSourcePage />);
    expect(await screen.findByRole("link", { name: /^Google Drive/ })).toHaveAttribute(
      "href",
      "/sources/new?kind=google_drive",
    );
  });

  it("sets the schedule and retention, then shows the agent token once", async () => {
    const fetch = stubApi({
      "GET /target": { body: target() },
      "POST /sources": { status: 201, body: { source: appSource(), token: TOKEN } },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<NewSourcePage kind="app" />);
    expect(await screen.findByText("Times are in the server's time zone, Europe/Berlin.")).toBeVisible();

    await user.type(screen.getByLabelText("Name"), "Wiki");
    // Daily by default; hourly asks for the step and the minute.
    expect(screen.getByLabelText("Repeat")).toHaveValue("daily");
    expect(screen.getByLabelText("Time")).toHaveValue("02:00");
    await user.selectOptions(screen.getByLabelText("Repeat"), "hourly");
    expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Every"), "6");
    await user.clear(screen.getByLabelText("At minute"));
    await user.type(screen.getByLabelText("At minute"), "15");
    // Weekly asks for the day and the time.
    await user.selectOptions(screen.getByLabelText("Repeat"), "weekly");
    await user.selectOptions(screen.getByLabelText("Day"), "Monday");
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "03:30" } });

    expect(
      screen.getByText(
        "With these numbers: the newest snapshot of each of the last 14 days, 8 weeks, and 12 months.",
      ),
    ).toBeVisible();
    await user.clear(screen.getByLabelText("Weeks"));
    await user.clear(screen.getByLabelText("Years"));
    await user.type(screen.getByLabelText("Years"), "2");
    expect(
      screen.getByText(
        "With these numbers: the newest snapshot of each of the last 14 days, 12 months, and 2 years.",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(requests(fetch, "POST /sources")).toHaveLength(1));
    expect(requests(fetch, "POST /sources")[0]!.body).toEqual({
      kind: "app",
      name: "Wiki",
      enabled: true,
      schedule: { type: "weekly", day: 1, time: "03:30" },
      retention: { daily: 14, weekly: 0, monthly: 12, yearly: 2 },
      config: {},
    });

    // The token stays hidden; the copy buttons copy it as it is.
    const dialog = await screen.findByRole("dialog", { name: "Connect the app's backup agent" });
    const token = within(dialog).getByLabelText("Agent token");
    expect(token).toHaveValue(TOKEN);
    expect(token).toHaveAttribute("type", "password");
    const lines = within(dialog).getByLabelText("Lines for the .env file");
    expect(lines).toHaveTextContent(`BACKUP_URL=${window.location.origin} BACKUP_TOKEN=••••••••`);
    expect(lines).not.toHaveTextContent(TOKEN);
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(TOKEN);
    await user.click(within(dialog).getByRole("button", { name: "Copy lines" }));
    expect(await navigator.clipboard.readText()).toBe(
      `BACKUP_URL=${window.location.origin}\nBACKUP_TOKEN=${TOKEN}`,
    );
    await user.click(within(dialog).getByRole("button", { name: "Show" }));
    expect(token).toHaveAttribute("type", "text");
    expect(dialog).toHaveTextContent("The backup agent runs next to the app");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/sources/${IDS.app}`));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("checks fields before sending", async () => {
    const fetch = stubApi({ "GET /target": { body: target() } });
    const user = userEvent.setup();
    renderPage(<NewSourcePage kind="app" />);
    await user.clear(await screen.findByLabelText("Days"));
    await user.clear(screen.getByLabelText("Weeks"));
    await user.clear(screen.getByLabelText("Months"));
    expect(screen.getByText("These numbers keep no snapshot.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add source" }));
    expect(await screen.findByText("Enter a name")).toBeVisible();
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Keep at least one snapshot")).toBeVisible();
    expect(screen.getByLabelText("Days")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Check the highlighted fields.")).toBeVisible();
    expect(requests(fetch, "POST /sources")).toHaveLength(0);
  });

  it("asks for the Google Drive settings and shows the server's field errors at the fields", async () => {
    const fetch = stubApi({
      "GET /target": { body: target() },
      "POST /sources": {
        status: 400,
        body: {
          error: {
            code: "validation_failed",
            message: "Check the highlighted fields",
            fields: {
              "config.subject": "This user is not in the Workspace",
              "config.scope.folders.1.id": "No folder with this ID",
              "secrets.serviceAccountKey": "Not a service account key",
            },
          },
        },
      },
    });
    const user = userEvent.setup();
    renderPage(<NewSourcePage kind="google_drive" />);
    await user.type(await screen.findByLabelText("Name"), "Team drive");
    await user.type(screen.getByLabelText("Workspace user to act as"), "backup@example.org");

    expect(screen.getByLabelText("Shared drive ID")).toBeVisible();
    await user.click(screen.getByRole("radio", { name: "Folders" }));
    expect(screen.queryByLabelText("Shared drive ID")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Folder ID 1"), "1AbCdEfGhIjKlMn");
    await user.type(screen.getByLabelText("Name of folder 1"), "Finance");
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    await user.type(screen.getByLabelText("Folder ID 2"), "1ZyXwVuTsRqPoNm");
    await user.type(screen.getByLabelText("Name of folder 2"), "Contracts");
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    await user.click(screen.getByRole("button", { name: "Remove folder 3" }));
    expect(screen.queryByLabelText("Folder ID 3")).not.toBeInTheDocument();

    // The key is hidden. Pasted with its line breaks, it loses them, and the client ID for
    // domain-wide delegation shows at once.
    expect(screen.getByText("The client ID shows here once a key is pasted.")).toBeVisible();
    const key = screen.getByLabelText("Service account key (JSON)");
    expect(key).toHaveAttribute("type", "password");
    await user.click(key);
    await user.paste(
      JSON.stringify(
        {
          type: "service_account",
          client_id: "998877665544",
          client_email: "sa@project.iam.gserviceaccount.com",
          private_key: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
        },
        null,
        2,
      ),
    );
    expect(screen.getByText("998877665544")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(key).toHaveAttribute("type", "text");
    expect(screen.getByText("https://www.googleapis.com/auth/drive.readonly")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(requests(fetch, "POST /sources")).toHaveLength(1));
    const body = requests(fetch, "POST /sources")[0]!.body as Record<string, unknown>;
    expect(body.config).toEqual({
      subject: "backup@example.org",
      scope: {
        type: "folders",
        folders: [
          { id: "1AbCdEfGhIjKlMn", label: "Finance" },
          { id: "1ZyXwVuTsRqPoNm", label: "Contracts" },
        ],
      },
    });
    const pasted = (body.secrets as { serviceAccountKey: string }).serviceAccountKey;
    expect(pasted).not.toContain("\n");
    expect(JSON.parse(pasted)).toMatchObject({
      client_id: "998877665544",
      private_key: expect.stringContaining("PRIVATE KEY"),
    });

    expect(await screen.findByText("This user is not in the Workspace")).toBeVisible();
    expect(screen.getByLabelText("Workspace user to act as")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Folder ID 2")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("No folder with this ID")).toBeVisible();
    expect(screen.getByText("Not a service account key")).toBeVisible();
    expect(screen.getByText("Check the highlighted fields.")).toBeVisible();
  });

  it("keeps a stored Google key unless a new one is pasted", async () => {
    const fetch = stubApi({
      "GET /target": { body: target() },
      [`GET /sources/${IDS.drive}`]: { body: driveSource() },
      [`PUT /sources/${IDS.drive}`]: { body: driveSource() },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<EditSourcePage id={IDS.drive} />);
    expect(
      await screen.findByText(
        "A key is stored (backups@project.iam.gserviceaccount.com). Paste a new key to replace it.",
      ),
    ).toBeVisible();
    expect(screen.getByText("112233445566778899")).toBeVisible();
    expect(screen.getByLabelText("Shared drive ID")).toHaveValue("0AbCdEfGhIjKlMnOp");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests(fetch, `PUT /sources/${IDS.drive}`)).toHaveLength(1));
    const body = requests(fetch, `PUT /sources/${IDS.drive}`)[0]!.body as Record<string, unknown>;
    expect(body.secrets).toEqual({});
    expect(body.config).toEqual({
      subject: "backup@example.org",
      scope: { type: "shared_drive", driveId: "0AbCdEfGhIjKlMnOp" },
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/sources/${IDS.drive}`));
  });

  it("asks for the Personio settings, with a write-only secret", async () => {
    const fetch = stubApi({
      "GET /target": { body: target() },
      [`GET /sources/${IDS.personio}`]: { body: personioSource() },
      [`PUT /sources/${IDS.personio}`]: { body: personioSource() },
    });
    const user = userEvent.setup();
    renderPage(<EditSourcePage id={IDS.personio} />);
    expect(await screen.findByLabelText("API URL")).toHaveValue("https://api.personio.de");
    expect(screen.getByText(/Settings → Integrations → API credentials/)).toBeVisible();
    expect(screen.getByText("Uses Personio's document API, which is in beta.")).toBeVisible();
    expect(screen.getByText("Stored (…f00d)")).toBeVisible();
    await user.click(screen.getByRole("switch", { name: "Back up documents" }));
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await user.type(screen.getByLabelText("Client secret"), "new-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests(fetch, `PUT /sources/${IDS.personio}`)).toHaveLength(1));
    expect(requests(fetch, `PUT /sources/${IDS.personio}`)[0]!.body).toMatchObject({
      kind: "personio",
      config: { baseUrl: "https://api.personio.de", clientId: "papi-123", documents: false },
      secrets: { clientSecret: "new-secret" },
    });
  });

  it("asks for the S3 bucket's address and a write-only secret key", async () => {
    const fetch = stubApi({
      "GET /target": { body: target() },
      "POST /sources": { status: 201, body: { source: s3Source(), token: null } },
    });
    const user = userEvent.setup();
    const { router } = renderPage(<NewSourcePage kind="s3_bucket" />);
    await user.type(await screen.findByLabelText("Name"), "Media files");
    await user.type(screen.getByLabelText("Endpoint"), "https://fsn1.your-objectstorage.com");
    await user.type(screen.getByLabelText("Region"), "fsn1");
    await user.type(screen.getByLabelText("Bucket name"), "acme-media");
    await user.type(screen.getByLabelText("Folder in the bucket"), "originals");
    await user.type(screen.getByLabelText("Access key"), "MEDIAREAD");
    await user.type(screen.getByLabelText("Secret key"), "media-secret");
    await user.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(requests(fetch, "POST /sources")).toHaveLength(1));
    expect(requests(fetch, "POST /sources")[0]!.body).toMatchObject({
      kind: "s3_bucket",
      config: {
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "fsn1",
        bucket: "acme-media",
        prefix: "originals",
        accessKeyId: "MEDIAREAD",
      },
      secrets: { secretAccessKey: "media-secret" },
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/sources/${IDS.s3}`));
  });
});
