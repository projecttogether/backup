import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title: "Audit log",
    description:
      "Who changed sources, the target or notifications, started or cancelled backups, and downloaded snapshots or the recovery kit. Entries never contain secrets.",
    empty: "No entries yet",
    emptyHint: "Changes by admins appear here as they happen.",
    colWhen: "When",
    colWho: "Who",
    colWhat: "What",
    system: "System",
    auditTable: "Audit log",
  },
});
