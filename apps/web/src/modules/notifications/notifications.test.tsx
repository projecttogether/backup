import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifications } from "@/test-fixtures";
import { renderPage, requests, stubApi } from "@/test-utils";
import { NotificationsPage } from "./notifications-page";

afterEach(() => vi.unstubAllGlobals());

const saved = notifications({
  email: {
    enabled: true,
    host: "smtp.example.org",
    port: 587,
    security: "starttls",
    username: "backups",
    passwordHint: "…pw12",
    from: "backups@example.org",
    recipients: ["it@example.org"],
  },
  heartbeatUrlHint: "https://hc-ping.com/…",
  heartbeat: { at: "2026-11-20T09:45:00.000Z", ok: true, message: null },
});

describe("notifications page", () => {
  it("saves the email settings, keeping the stored password", async () => {
    const fetch = stubApi({ "GET /notifications": { body: saved }, "PUT /notifications": { body: saved } });
    const user = userEvent.setup();
    renderPage(<NotificationsPage />);
    const recipients = await screen.findByLabelText("Recipients");
    expect(recipients).toHaveValue("it@example.org");
    expect(screen.getByText("Stored (…pw12)")).toBeVisible();
    expect(screen.getByText("Stored (https://hc-ping.com/…)")).toBeVisible();
    await user.type(recipients, "\nceo@example.org\n");
    await user.selectOptions(screen.getByLabelText("Security"), "tls");
    await user.clear(screen.getByLabelText("Port"));
    await user.type(screen.getByLabelText("Port"), "465");
    await user.click(screen.getByRole("switch", { name: "Also email when a source is back to normal" }));
    expect(screen.getByText("Save your changes first: tests use the saved settings.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests(fetch, "PUT /notifications")).toHaveLength(1));
    expect(requests(fetch, "PUT /notifications")[0]!.body).toEqual({
      email: {
        enabled: true,
        host: "smtp.example.org",
        port: 465,
        security: "tls",
        username: "backups",
        from: "backups@example.org",
        recipients: ["it@example.org", "ceo@example.org"],
      },
      notifyRecovery: false,
    });
  });

  it("replaces or removes the stored heartbeat URL", async () => {
    const fetch = stubApi({ "GET /notifications": { body: saved }, "PUT /notifications": { body: saved } });
    const user = userEvent.setup();
    renderPage(<NotificationsPage />);
    const heartbeat = async (button: string) => {
      const field = (await screen.findByText("Heartbeat URL")).closest<HTMLElement>("[data-slot=field]")!;
      await user.click(within(field).getByRole("button", { name: button }));
    };
    await heartbeat("Replace");
    const input = screen.getByLabelText("Heartbeat URL");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
    await user.type(input, "https://hc-ping.com/new");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests(fetch, "PUT /notifications")).toHaveLength(1));
    await heartbeat("Remove");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests(fetch, "PUT /notifications")).toHaveLength(2));
    expect(
      requests(fetch, "PUT /notifications").map(
        ({ body }) => (body as { heartbeatUrl?: unknown }).heartbeatUrl,
      ),
    ).toEqual(["https://hc-ping.com/new", null]);
  });

  it("checks the addresses before saving", async () => {
    const fetch = stubApi({ "GET /notifications": { body: saved } });
    const user = userEvent.setup();
    renderPage(<NotificationsPage />);
    await user.type(await screen.findByLabelText("Recipients"), "\nnot an address");
    for (const button of screen.getAllByRole("button", { name: "Replace" })) await user.click(button);
    await user.type(screen.getByLabelText("Heartbeat URL"), "ftp://monitor");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter email addresses")).toBeVisible();
    expect(screen.getByText("Enter an http(s) URL")).toBeVisible();
    expect(screen.getByLabelText("Recipients")).toHaveAttribute("aria-invalid", "true");
    expect(requests(fetch, "PUT /notifications")).toHaveLength(0);
  });

  it("sends a test email and tests the heartbeat", async () => {
    const fetch = stubApi({
      "GET /notifications": { body: saved },
      "POST /notifications/test-email": {
        body: { ok: false, message: "Connection refused by smtp.example.org" },
      },
      "POST /notifications/test-heartbeat": { body: { ok: true, message: "The monitor answered 200 OK" } },
    });
    const user = userEvent.setup();
    renderPage(<NotificationsPage />);
    expect(await screen.findByText(/healthchecks\.io or Uptime Kuma/)).toBeVisible();
    expect(screen.getByText("Succeeded")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByText("Connection refused by smtp.example.org")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Test heartbeat" }));
    expect(await screen.findByText("The monitor answered 200 OK")).toBeVisible();
    expect(requests(fetch, "POST /notifications/test-email")).toHaveLength(1);
    // The last call is read again after a test.
    await waitFor(() => expect(requests(fetch, "GET /notifications")).toHaveLength(2));
  });
});
