import { useEffect } from "react";
import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { AppFrame, type FrameLink, type NavGroup } from "@/components/ui/app-frame";
import { AppIcon, SidebarOrganization } from "@/components/brand";
import { useMe } from "@/hooks/use-me";
import { useTheme } from "@/lib/theme";
import { authClient } from "@/lib/auth-client";
import { DEFAULT_APP_NAME, useAuthConfig } from "@/lib/auth-config";
import { queryClient } from "@/lib/query";
import { common } from "@/i18n/common";
import { defineMessages, useT } from "@/i18n";
import { breadcrumbsFor, NAVIGATION, navMessages, PREFERENCES_PATH, recordOf } from "@/app/navigation";
import { useRecordName } from "@/app/record-name";
import { messages as preferencesMessages } from "@/modules/preferences/messages";
import { messages as sourceMessages } from "@/modules/sources/messages";

const messages = defineMessages({
  en: {
    admin: "Admin",
  },
});

/**
 * TanStack Router's link for the frame: every other prop goes on to the <a>.
 * Exact, so that the router marks only the page itself as current, not the
 * breadcrumb of its parent; the frame marks the sidebar item.
 */
const AppLink: FrameLink = ({ href, ...props }) => (
  <Link to={href} activeOptions={{ exact: true }} {...props} />
);

/** The signed-in application frame: the AppFrame with the navigation of Backup. */
export function AppLayout() {
  const me = useMe();
  const m = useT(messages);
  const t = useT(navMessages);
  const tCommon = useT(common);
  const tSources = useT(sourceMessages);
  const tPreferences = useT(preferencesMessages);
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const record = useRecordName(recordOf(pathname));
  const { theme, setTheme } = useTheme();
  const appName = useAuthConfig()?.appName || DEFAULT_APP_NAME;
  useEffect(() => {
    document.title = appName;
  }, [appName]);

  const nav: NavGroup[] = NAVIGATION.map((group) => ({
    label: t(group.key),
    items: group.items.map((item) => ({ label: t(item.key), href: item.to, shortcut: item.shortcut })),
  }));
  const breadcrumbs = breadcrumbsFor(pathname, {
    items: nav.flatMap((group) => group.items),
    labels: {
      newSource: tSources("chooseTitle"),
      edit: tCommon("edit"),
      preferences: tPreferences("title"),
      source: t("sourceDetails"),
      run: t("runDetails"),
    },
    record,
  });

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    window.location.assign("/sign-in");
  };

  return (
    // No `search`: the API has no text search, so the search offers the pages.
    <AppFrame
      app={{ name: appName, icon: <AppIcon /> }}
      sidebarFooter={<SidebarOrganization />}
      nav={nav}
      pathname={pathname}
      link={AppLink}
      navigate={(href) => void router.navigate({ to: href })}
      user={{
        name: me.name || me.email,
        email: me.email,
        detail: me.isAdmin ? m("admin") : undefined,
        image: me.image,
      }}
      theme={theme}
      onThemeChange={setTheme}
      settingsHref={PREFERENCES_PATH}
      onSignOut={() => void signOut()}
      breadcrumbs={breadcrumbs}
    >
      <Outlet />
    </AppFrame>
  );
}
