import { describe, expect, it } from "vitest";
import { breadcrumbsFor, NAVIGATION, recordOf } from "./navigation";

const ID = "0b5a3e5e-3c1f-4d8e-9f3a-000000000001";
const items = [
  { label: "Dashboard", href: "/" },
  { label: "Sources", href: "/sources" },
  { label: "Runs", href: "/runs" },
  { label: "Target", href: "/settings/target" },
  { label: "Notifications", href: "/settings/notifications" },
  { label: "Audit log", href: "/admin/audit" },
];
const labels = {
  newSource: "Add source",
  edit: "Edit",
  preferences: "My settings",
  source: "Source details",
  run: "Run details",
};
const crumbs = (pathname: string, record?: string) => breadcrumbsFor(pathname, { items, labels, record });

describe("NAVIGATION", () => {
  it("gives each main page its own letter, the start page o, and settings pages none", () => {
    const all = NAVIGATION.flatMap((group) => group.items);
    const shortcuts = all.flatMap((item) => (item.shortcut ? [item.shortcut] : []));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    expect(all.find((item) => item.to === "/")?.shortcut).toBe("o");
    const settings = NAVIGATION.find((group) => group.key === "settings")!;
    expect(settings.items.every((item) => !item.shortcut)).toBe(true);
  });
});

describe("recordOf", () => {
  it("finds the source of its page and edit form, and the run", () => {
    expect(recordOf(`/sources/${ID}`)).toEqual({ kind: "source", id: ID });
    expect(recordOf(`/sources/${ID}/edit/`)).toEqual({ kind: "source", id: ID });
    expect(recordOf(`/runs/${ID}`)).toEqual({ kind: "run", id: ID });
  });

  it("has none for lists, the new form and other paths", () => {
    expect(recordOf("/sources")).toBeNull();
    expect(recordOf("/sources/new")).toBeNull();
    expect(recordOf("/runs")).toBeNull();
    expect(recordOf(`/runs/${ID}/edit`)).toBeNull();
    expect(recordOf(`/sources/${ID}/other`)).toBeNull();
    expect(recordOf("/settings/target")).toBeNull();
  });
});

describe("breadcrumbsFor", () => {
  it("names the sidebar page itself", () => {
    expect(crumbs("/")).toEqual([{ label: "Dashboard" }]);
    expect(crumbs("/sources/")).toEqual([{ label: "Sources" }]);
    expect(crumbs("/runs")).toEqual([{ label: "Runs" }]);
    expect(crumbs("/settings/target")).toEqual([{ label: "Target" }]);
    expect(crumbs("/admin/audit")).toEqual([{ label: "Audit log" }]);
  });

  it("leads back from the new form", () => {
    expect(crumbs("/sources/new")).toEqual([{ label: "Sources", href: "/sources" }, { label: "Add source" }]);
  });

  it("names a source or a run by its name once it has loaded", () => {
    expect(crumbs(`/sources/${ID}`, "Wiki")).toEqual([
      { label: "Sources", href: "/sources" },
      { label: "Wiki" },
    ]);
    expect(crumbs(`/runs/${ID}`, "Wiki")).toEqual([{ label: "Runs", href: "/runs" }, { label: "Wiki" }]);
  });

  it("keeps the list a link back while the name loads or fails to", () => {
    expect(crumbs(`/sources/${ID}`)).toEqual([
      { label: "Sources", href: "/sources" },
      { label: "Source details" },
    ]);
    expect(crumbs(`/runs/${ID}/`)).toEqual([{ label: "Runs", href: "/runs" }, { label: "Run details" }]);
  });

  it("leads from the edit form back to its source", () => {
    expect(crumbs(`/sources/${ID}/edit`, "Wiki")).toEqual([
      { label: "Sources", href: "/sources" },
      { label: "Wiki", href: `/sources/${ID}` },
      { label: "Edit" },
    ]);
    // Before the name is there, every step before the page still links.
    expect(crumbs(`/sources/${ID}/edit`)).toEqual([
      { label: "Sources", href: "/sources" },
      { label: "Edit" },
    ]);
  });

  it("names the person's settings, and nothing for pages outside the sidebar", () => {
    expect(crumbs("/preferences")).toEqual([{ label: "My settings" }]);
    expect(crumbs("/somewhere")).toEqual([]);
    expect(crumbs("/sources-old")).toEqual([]);
    expect(crumbs("/settings")).toEqual([]);
    expect(crumbs(`/sources/${ID}/other`, "Wiki")).toEqual([{ label: "Sources", href: "/sources" }]);
  });
});
