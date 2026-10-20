// App root: auth gate, hash routing, shell composition (PCMS-ADMIN-T001).
import {
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
} from "react";
import { useAuth } from "./auth/AuthContext.js";
import { InviteAcceptScreen } from "./auth/InviteAcceptScreen.js";
import { LoginScreen } from "./auth/LoginScreen.js";
import { EmptyState, Spinner } from "./design/ui.js";
import { useExtensionContributions } from "./extension/contributions.js";
import { type AdminRoute, extensionRoutes } from "./extension/registry.js";
import { t, useLocale } from "./i18n/index.js";
import { matchRoute, useRoute } from "./layout/router.js";
import { type Crumb, Shell } from "./layout/Shell.js";
import { AuditScreen } from "./screens/audit/AuditScreen.js";
import { ContentScreen } from "./screens/content/ContentScreen.js";
import { DashboardScreen } from "./screens/dashboard.js";
import { IntegrationsScreen } from "./screens/integrations/IntegrationsScreen.js";
import { MediaScreen } from "./screens/media/MediaScreen.js";
import { NavigationScreen } from "./screens/navigation/NavigationScreen.js";
import { NotificationsScreen } from "./screens/notifications/NotificationsScreen.js";
import { PaymentsScreen } from "./screens/payments/PaymentsScreen.js";
import { ChangesetsScreen } from "./screens/publication/PublicationScreen.js";
import { SearchScreen } from "./screens/search/SearchScreen.js";
import { AnalyticsScreen } from "./screens/settings/AnalyticsScreen.js";
import { SettingsScreen, SystemScreen } from "./screens/settings/SettingsScreen.js";
import SkillsScreen from "./screens/skills/SkillsScreen.js";
import { ThemeScreen } from "./screens/theme/ThemeScreen.js";
import { UsersAccessScreen } from "./screens/users/UsersAccessScreen.js";

// Preserve the lazy type across shell rerenders; changed loaders get a fresh screen.
const extensionScreens = new WeakMap<
  AdminRoute["load"],
  LazyExoticComponent<ComponentType<Record<string, string>>>
>();

interface Screen {
  readonly pattern: string;
  readonly titleKey: string;
  readonly permission?: string;
  readonly render: (params: Readonly<Record<string, string>>) => ReactNode;
}

function PermissionDenied() {
  return <EmptyState title={t("permission_denied_title")} hint={t("permission_denied_text")} />;
}

const CORE_SCREENS: readonly Screen[] = [
  { pattern: "", titleKey: "dashboard_title", render: () => <DashboardScreen /> },
  {
    pattern: "content",
    titleKey: "nav_content",
    permission: "content.read",
    render: () => <ContentScreen />,
  },
  {
    pattern: "content/:entryId",
    titleKey: "nav_content",
    permission: "content.read",
    render: () => <ContentScreen />,
  },
  {
    pattern: "media",
    titleKey: "nav_media",
    permission: "media.read",
    render: () => <MediaScreen />,
  },
  {
    pattern: "media/*",
    titleKey: "nav_media",
    permission: "media.read",
    render: () => <MediaScreen />,
  },
  {
    pattern: "navigation",
    titleKey: "nav_navigation",
    permission: "navigation.read",
    render: () => <NavigationScreen />,
  },
  {
    pattern: "navigation/*",
    titleKey: "nav_navigation",
    permission: "navigation.read",
    render: () => <NavigationScreen />,
  },
  {
    pattern: "publication",
    titleKey: "nav_publication",
    permission: "publication.read",
    render: () => <ChangesetsScreen />,
  },
  {
    pattern: "publication/*",
    titleKey: "nav_publication",
    permission: "publication.read",
    render: () => <ChangesetsScreen />,
  },
  {
    pattern: "search",
    titleKey: "nav_search",
    permission: "content.read",
    render: () => <SearchScreen />,
  },
  {
    pattern: "skills",
    titleKey: "nav_skills",
    permission: "audit.read",
    render: () => <SkillsScreen />,
  },
  {
    pattern: "integrations",
    titleKey: "nav_integrations",
    permission: "integrations.read",
    render: () => <IntegrationsScreen />,
  },
  {
    pattern: "integrations/*",
    titleKey: "nav_integrations",
    permission: "integrations.read",
    render: () => <IntegrationsScreen />,
  },
  {
    pattern: "payments",
    titleKey: "nav_payments",
    permission: "payments.read",
    render: () => <PaymentsScreen />,
  },
  {
    pattern: "payments/*",
    titleKey: "nav_payments",
    permission: "payments.read",
    render: () => <PaymentsScreen />,
  },
  {
    pattern: "theme",
    titleKey: "nav_theme",
    permission: "theme.read",
    render: () => <ThemeScreen />,
  },
  {
    pattern: "users",
    titleKey: "nav_users",
    permission: "users.read",
    render: () => <UsersAccessScreen />,
  },
  {
    pattern: "analytics",
    titleKey: "analytics.screen_title",
    permission: "analytics.read",
    render: () => <AnalyticsScreen />,
  },
  {
    pattern: "notifications",
    titleKey: "nav_notifications",
    permission: "integrations.read",
    render: () => <NotificationsScreen />,
  },
  {
    pattern: "settings",
    titleKey: "nav_settings",
    permission: "seo.read",
    render: () => <SettingsScreen />,
  },
  {
    pattern: "audit",
    titleKey: "nav_audit",
    permission: "audit.read",
    render: () => <AuditScreen />,
  },
  {
    pattern: "system",
    titleKey: "nav_system",
    permission: "site.validate",
    render: () => <SystemScreen />,
  },
  {
    // PCMS-PRE-RESEARCH A5: maintenance control moved into System — the old
    // route redirects so stale links/bookmarks keep working.
    pattern: "maintenance",
    titleKey: "nav_system",
    permission: "site.maintenance",
    render: () => <SystemRedirect />,
  },
];

function SystemRedirect() {
  useEffect(() => {
    window.location.hash = "#/system";
  }, []);
  return null;
}

function crumbsFor(segments: readonly string[], titleKey: string): readonly Crumb[] {
  const crumbs: Crumb[] = [{ title: t("dashboard_title"), path: "" }];
  if (segments.length > 0) {
    crumbs.push({ title: t(titleKey) });
  }
  return crumbs;
}

export function App() {
  useLocale(); // re-render the whole tree when the Admin UI locale switches
  const auth = useAuth();
  const route = useRoute();
  // Extension UI contributions (ADR-0017 S6): compose the ENABLED set after
  // authentication and on any Extensions-screen lifecycle change; the
  // registry version re-renders the tree so nav/routes appear/disappear.
  useExtensionContributions(auth.state.status);

  if (auth.state.status === "loading") {
    return <Spinner label={t("loading")} />;
  }
  // /invite/{token} works in ANY auth state: the recipient is often the
  // operator himself, already logged in as another user (owner report:
  // authenticated session → the old guard fell through to the admin 404).
  // The invite sets the password of the INVITED identity, never the
  // current session.
  if (route.segments[0] === "invite") {
    return <InviteAcceptScreen authenticated={auth.state.status === "authed"} />;
  }
  if (auth.state.status === "anonymous" || auth.state.status === "mfa") {
    return <LoginScreen />;
  }

  const extensionMatch = extensionRoutes()
    .map((registered) => ({ registered, params: matchRoute(registered.pattern, route.segments) }))
    .find((candidate) => candidate.params !== null);
  const coreMatch = CORE_SCREENS.map((screen) => ({
    screen,
    params: matchRoute(screen.pattern, route.segments),
  })).find((candidate) => candidate.params !== null);

  let content: ReactNode;
  let titleKey = "dashboard_title";
  if (extensionMatch !== undefined && extensionMatch.params !== null) {
    const load = extensionMatch.registered.load;
    let Extension = extensionScreens.get(load);
    if (Extension === undefined) {
      Extension = lazy(load);
      extensionScreens.set(load, Extension);
    }
    titleKey = extensionMatch.registered.title;
    content =
      extensionMatch.registered.permission === undefined ||
      auth.can(extensionMatch.registered.permission) ? (
        <Suspense fallback={<Spinner />}>
          <Extension {...(extensionMatch.params ?? {})} />
        </Suspense>
      ) : (
        <PermissionDenied />
      );
  } else if (coreMatch !== undefined && coreMatch.params !== null) {
    titleKey = coreMatch.screen.titleKey;
    content =
      coreMatch.screen.permission === undefined || auth.can(coreMatch.screen.permission) ? (
        coreMatch.screen.render(coreMatch.params)
      ) : (
        <PermissionDenied />
      );
  } else {
    content = <EmptyState title={t("core.page_not_found")} hint={t("core.page_not_found_hint")} />;
  }

  return (
    <Shell route={route} crumbs={crumbsFor(route.segments, titleKey)}>
      {content}
    </Shell>
  );
}
