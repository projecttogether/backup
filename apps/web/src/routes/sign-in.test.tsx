import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "@/router";
import { stubApi } from "@/test-utils";

afterEach(() => vi.unstubAllGlobals());

describe("the sign-in page", () => {
  it("shows the app with its icon, and ProjectTogether as the organization that makes it", async () => {
    stubApi({
      "GET /me": { status: 401, body: { error: { code: "unauthorized", message: "Sign in first" } } },
      "GET /auth-config": { body: { appName: "Backup", providerName: "Keycloak" } },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({
      history: createMemoryHistory({ initialEntries: ["/sign-in"] }),
      queryClient,
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "Sign in with Keycloak" })).toBeEnabled();
    expect(container.querySelector('img[src="/favicon.svg"]')).not.toBeNull();
    expect(screen.getAllByText(/Backup is open source, made by ProjectTogether\./).length).toBeGreaterThan(0);
    for (const link of screen.getAllByRole("link", { name: /Source code/ })) {
      expect(link).toHaveAttribute("href", "https://github.com/projecttogether/backup");
    }
  });
});
