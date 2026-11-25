import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@backup/shared/api/users";
import { createAppRouter } from "@/router";
import { appSource, IDS, run } from "@/test-fixtures";
import { stubApi } from "@/test-utils";

const ME: Me = { id: IDS.run, email: "ada@example.org", name: "Ada Admin", image: null, isAdmin: true };

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  stubApi({
    "GET /me": { body: ME },
    "GET /auth-config": { body: { appName: "Backup", providerName: "Keycloak" } },
    "GET /about": { body: { version: "0123456789ab" } },
    [`GET /sources/${IDS.app}`]: { body: appSource() },
    [`GET /sources/${IDS.app}/snapshots`]: { body: { items: [] } },
    "GET /runs": { body: { items: [run()], total: 1 } },
    [`GET /runs/${IDS.run}`]: { body: { ...run(), log: [] } },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }), queryClient });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("app frame", () => {
  it("shows the navigation as text and where the page sits", async () => {
    renderAt(`/sources/${IDS.app}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Wiki" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Dashboard", "Sources", "Runs", "Target", "Notifications", "Audit log"]);
    expect(nav.querySelector("svg")).toBeNull();
    // The organization that makes the app, in the sidebar's footer.
    expect(screen.getByText("ProjectTogether")).toBeVisible();
    expect(within(nav).getByRole("link", { name: "Sources" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    const parent = within(crumbs).getByRole("link", { name: "Sources" });
    expect(parent).toHaveAttribute("href", "/sources");
    // Only the sidebar item is the current page, not the breadcrumb that leads back.
    expect(parent).not.toHaveAttribute("aria-current");
    expect(await within(crumbs).findByText("Wiki")).toHaveAttribute("aria-current", "page");
  });

  it("keeps the list a link back when a source does not load", async () => {
    // No reply for this source: the page shows its error.
    renderAt(`/sources/${IDS.drive}`);
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumbs" });
    expect(within(crumbs).getByRole("link", { name: "Sources" })).toHaveAttribute("href", "/sources");
    expect(within(crumbs).getByText("Source details")).toHaveAttribute("aria-current", "page");
  });

  it("names a run by its source in the breadcrumbs", async () => {
    renderAt(`/runs/${IDS.run}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Wiki" })).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(within(crumbs).getByRole("link", { name: "Runs" })).toHaveAttribute("href", "/runs");
    expect(await within(crumbs).findByText("Wiki")).toHaveAttribute("aria-current", "page");
  });

  it("opens the person's settings from the user menu", async () => {
    const user = userEvent.setup();
    renderAt("/sources");
    await user.click(await screen.findByRole("button", { name: /^Ada Admin/ }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Appearance",
      "Settings",
      "Keyboard shortcutsCtrl /",
      "Sign out",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(await screen.findByRole("heading", { level: 1, name: "My settings" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /single letters/ })).toBeChecked();
    expect(screen.getByRole("link", { name: /Source code on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/projecttogether/backup",
    );
    expect(await screen.findByRole("link", { name: "Version 0123456789ab" })).toHaveAttribute(
      "href",
      "https://github.com/projecttogether/backup/commit/0123456789ab",
    );
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    expect(within(crumbs).getByText("My settings")).toBeInTheDocument();
  });
});
