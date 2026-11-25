import { defineMessages } from "@/i18n";

export const navMessages = defineMessages({
  en: {
    backups: "Backups",
    dashboard: "Dashboard",
    sources: "Sources",
    runs: "Runs",
    settings: "Settings",
    target: "Target",
    notifications: "Notifications",
    audit: "Audit log",
    // Breadcrumbs of a source or run until its page has its name.
    sourceDetails: "Source details",
    runDetails: "Run details",
  },
});

export type NavKey = keyof typeof navMessages.en;
/** `shortcut`: "G then this letter" opens the page (main pages only, each letter once; "o" is the start page). */
export type NavItem = { key: NavKey; to: string; shortcut?: string };
export type NavGroup = { key: NavKey; items: NavItem[] };

/**
 * The sidebar, as text. Only admins sign in, so everyone sees all of it.
 * The main action ("Add source") sits in the header of the sources page.
 */
export const NAVIGATION: NavGroup[] = [
  {
    key: "backups",
    items: [
      { key: "dashboard", to: "/", shortcut: "o" },
      { key: "sources", to: "/sources", shortcut: "s" },
      { key: "runs", to: "/runs", shortcut: "r" },
    ],
  },
  {
    key: "settings",
    items: [
      { key: "target", to: "/settings/target" },
      { key: "notifications", to: "/settings/notifications" },
      { key: "audit", to: "/admin/audit" },
    ],
  },
];

/** The person's own settings (appearance, keyboard shortcuts), outside the sidebar. */
export const PREFERENCES_PATH = "/preferences";

export type Crumb = { label: string; href?: string };

/** The source (its page or edit form) or run a path shows, so the header can name it; not the new form. */
export function recordOf(pathname: string): { kind: "source" | "run"; id: string } | null {
  const source = /^\/sources\/([^/]+)(?:\/edit)?\/?$/.exec(pathname);
  if (source && source[1] !== "new") return { kind: "source", id: source[1]! };
  const run = /^\/runs\/([^/]+)\/?$/.exec(pathname);
  return run ? { kind: "run", id: run[1]! } : null;
}

/**
 * Where a page sits: the sidebar item it belongs to, then the new form or
 * the source or run by its name (until its page has loaded it, "Source
 * details" or "Run details", so the list stays a link back), then the edit
 * form. Sources and runs have no short numbers. The person's settings are
 * outside the sidebar; other paths get none.
 */
export function breadcrumbsFor(
  pathname: string,
  options: {
    items: { label: string; href: string }[];
    labels: { newSource: string; edit: string; preferences: string; source: string; run: string };
    /** The name of the source or run the page shows, once loaded. */
    record?: string;
  },
): Crumb[] {
  const { items, labels, record } = options;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === PREFERENCES_PATH) return [{ label: labels.preferences }];
  const item = items
    .filter((candidate) =>
      candidate.href === "/"
        ? path === "/"
        : path === candidate.href || path.startsWith(`${candidate.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (!item) return [];
  if (path === item.href) return [{ label: item.label }];
  const parent = { label: item.label, href: item.href };
  const [id, below] = path.slice(item.href.length + 1).split("/");
  if (item.href === "/sources" && id === "new" && !below) return [parent, { label: labels.newSource }];
  const shown = recordOf(path);
  if (!shown) return [parent];
  if (below !== "edit") return [parent, { label: record ?? labels[shown.kind] }];
  const edit = { label: labels.edit };
  return record ? [parent, { label: record, href: `${item.href}/${id}` }, edit] : [parent, edit];
}
