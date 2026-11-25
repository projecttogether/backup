import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appSource, dashboard, driveSource, IDS, personioSource, run } from "@/test-fixtures";
import { renderPage, requests, stubApi, stubFetch } from "@/test-utils";
import { dashboardBusy } from "./api";
import { DashboardPage } from "./dashboard-page";

afterEach(() => vi.unstubAllGlobals());

function rowOf(name: string) {
  return screen.getByRole("link", { name }).closest("tr")!;
}

describe("dashboard", () => {
  it("shows what needs attention first, with links", async () => {
    stubFetch({
      body: dashboard({
        attention: [
          { level: "error", message: "Store the recovery kit", link: "/settings/target" },
          { level: "warning", message: "Object Lock is off", link: null },
        ],
      }),
    });
    renderPage(<DashboardPage />);
    const first = await screen.findByText("Store the recovery kit");
    const alerts = screen.getAllByRole("alert");
    expect(alerts[0]).toHaveTextContent("Store the recovery kit");
    expect(alerts[1]).toHaveTextContent("Object Lock is off");
    expect(within(alerts[0]!).getByRole("link", { name: "Open: Store the recovery kit" })).toHaveAttribute(
      "href",
      "/settings/target",
    );
    expect(within(alerts[1]!).queryByRole("link")).not.toBeInTheDocument();
    // The attention comes before the sources.
    expect(first.compareDocumentPosition(screen.getByRole("heading", { name: "Sources" }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("labels each source's state", async () => {
    stubFetch({
      body: dashboard({
        sources: [
          appSource({ id: "0b5a3e5e-3c1f-4d8e-9f3a-100000000001", name: "OK app", status: "ok" }),
          appSource({ id: "0b5a3e5e-3c1f-4d8e-9f3a-100000000002", name: "Queued app", status: "queued" }),
          driveSource({ id: "0b5a3e5e-3c1f-4d8e-9f3a-100000000003", name: "Queued drive", status: "queued" }),
          driveSource({ id: "0b5a3e5e-3c1f-4d8e-9f3a-100000000004", name: "Failed drive", status: "failed" }),
          personioSource({ id: "0b5a3e5e-3c1f-4d8e-9f3a-100000000005", name: "Overdue", status: "overdue" }),
          personioSource({ id: "0b5a3e5e-3c1f-4d8e-9f3a-100000000006", name: "Warned", status: "warning" }),
          personioSource({ id: "0b5a3e5e-3c1f-4d8e-9f3a-100000000007", name: "Running", status: "running" }),
          personioSource({ id: "0b5a3e5e-3c1f-4d8e-9f3a-100000000008", name: "New", status: "never" }),
          personioSource({
            id: "0b5a3e5e-3c1f-4d8e-9f3a-100000000009",
            name: "Off",
            status: "paused",
            enabled: false,
          }),
        ],
      }),
    });
    renderPage(<DashboardPage />);
    await screen.findByRole("link", { name: "OK app" });
    expect(screen.getByRole("region", { name: "Sources" })).toBeInTheDocument();
    expect(rowOf("OK app")).toHaveTextContent("OK");
    expect(rowOf("OK app")).toHaveTextContent("App (backup agent)");
    expect(rowOf("OK app")).toHaveTextContent("5 GB");
    expect(rowOf("Queued app")).toHaveTextContent("Waiting for the agent");
    expect(rowOf("Queued drive")).toHaveTextContent("Waiting");
    expect(rowOf("Queued drive")).not.toHaveTextContent("for the agent");
    expect(rowOf("Failed drive")).toHaveTextContent("Failed");
    expect(rowOf("Overdue")).toHaveTextContent("Overdue");
    expect(rowOf("Warned")).toHaveTextContent("Warning");
    expect(rowOf("Running")).toHaveTextContent("Running");
    expect(rowOf("New")).toHaveTextContent("No backup yet");
    expect(rowOf("Off")).toHaveTextContent("Paused");
    expect(rowOf("Off")).toHaveTextContent("Not scheduled");
    // A source that waits or runs cannot be started twice.
    expect(within(rowOf("Running")).getByRole("button", { name: "Back up Running now" })).toBeDisabled();
    expect(within(rowOf("OK app")).getByRole("button", { name: "Back up OK app now" })).toBeEnabled();
  });

  it("starts a backup from the table", async () => {
    const fetch = stubApi({
      "GET /dashboard": { body: dashboard() },
      [`POST /sources/${IDS.app}/run`]: { status: 202, body: run({ status: "queued" }) },
    });
    renderPage(<DashboardPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Back up Wiki now" }));
    await waitFor(() => expect(requests(fetch, `POST /sources/${IDS.app}/run`)).toHaveLength(1));
    expect(
      await screen.findByText("Backup requested. The agent starts it when it next checks in."),
    ).toBeVisible();
  });

  it("explains the kinds of sources when there are none", async () => {
    stubFetch({ body: dashboard({ sources: [], recentRuns: [], maintenance: null }) });
    renderPage(<DashboardPage />);
    expect(await screen.findByRole("heading", { name: "No sources yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add source" })).toHaveAttribute("href", "/sources/new");
    expect(screen.getByRole("link", { name: /^App \(backup agent\)/ })).toHaveAttribute(
      "href",
      "/sources/new?kind=app",
    );
    expect(screen.getByRole("link", { name: /^Google Drive/ })).toHaveAttribute(
      "href",
      "/sources/new?kind=google_drive",
    );
    expect(screen.getByRole("link", { name: /^Personio/ })).toHaveAttribute(
      "href",
      "/sources/new?kind=personio",
    );
    expect(screen.queryByRole("region", { name: "Sources" })).not.toBeInTheDocument();
    expect(screen.getByText("No runs yet.")).toBeInTheDocument();
  });

  it("shows the target and the system at a glance", async () => {
    stubFetch({ body: dashboard() });
    renderPage(<DashboardPage />);
    expect(await screen.findByText("Last upkeep")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("42 GB")).toBeInTheDocument();
    expect(screen.getByText("Not stored yet")).toBeInTheDocument();
    expect(screen.getByText("Not run yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Target settings" })).toHaveAttribute("href", "/settings/target");
  });

  it("asks more often while something waits or runs", () => {
    expect(dashboardBusy(dashboard())).toBe(false);
    expect(dashboardBusy(dashboard({ sources: [appSource({ status: "running" })] }))).toBe(true);
    expect(dashboardBusy(dashboard({ selfBackup: run({ kind: "self", status: "queued" }) }))).toBe(true);
  });
});
