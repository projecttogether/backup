import { useQuery } from "@tanstack/react-query";
import type { About } from "@backup/shared/api/users";
import { Page, PageHeader } from "@/components/ui/page";
import { AboutCard, AppearanceCard, KeyboardShortcutsCard } from "@/components/ui/settings-cards";
import { OrganizationLogo } from "@/components/brand";
import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { commitUrl, REPOSITORY_URL } from "@/lib/repository";
import { useTheme } from "@/lib/theme";
import { messages } from "./messages";

/** The person's own settings: appearance, single-letter shortcuts (WCAG 2.1.4), about. */
export function PreferencesPage() {
  const t = useT(messages);
  const { theme, setTheme } = useTheme();
  const about = useQuery({ queryKey: ["about"], queryFn: () => api.get<About>("/about") }).data;
  const version = about?.version;
  return (
    <Page className="max-w-3xl">
      <PageHeader title={t("title")} description={t("description")} />
      <AppearanceCard value={theme} onChange={setTheme} />
      <KeyboardShortcutsCard />
      {/* The software's name, also when an installation renames the app. */}
      <AboutCard
        logo={<OrganizationLogo className="size-10 rounded-md" />}
        text={t("about")}
        version={version}
        versionHref={version ? commitUrl(version) : undefined}
        repositoryUrl={REPOSITORY_URL}
      />
    </Page>
  );
}
