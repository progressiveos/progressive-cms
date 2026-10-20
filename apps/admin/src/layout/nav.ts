// Core navigation model (Admin spec §3; redesign concept §8): grouped nav
// with domain-colored Font Awesome icons. Group rule: a group with a single
// item is not created; an item named like its group gets a content name
// ("Content" → "Entries"). Permissions filter visibility; the server
// remains the authority (Admin spec §56).
import type { AdminIconName } from "../design/icons.js";
import type { DomainAccent } from "../design/ui.js";

export interface NavItem {
  readonly id: string;
  readonly titleKey: string;
  readonly path: string;
  readonly permission?: string;
  readonly icon: AdminIconName;
  readonly accent: DomainAccent;
}

/** Display groups; extension sections are merged in via SECTION_GROUP. */
export interface NavGroup {
  readonly id: string;
  readonly titleKey: string;
  readonly items: readonly NavItem[];
}

export const CORE_NAV: readonly NavGroup[] = [
  {
    id: "content",
    titleKey: "nav_group_content",
    items: [
      {
        id: "content-tree",
        titleKey: "nav_content",
        path: "content",
        permission: "content.read",
        icon: "content",
        accent: "content",
      },
      {
        id: "media-library",
        titleKey: "nav_media",
        path: "media",
        permission: "media.read",
        icon: "media",
        accent: "media",
      },
      {
        id: "nav-sets",
        titleKey: "nav_navigation",
        path: "navigation",
        permission: "navigation.read",
        icon: "navigation",
        accent: "navigation",
      },
      {
        id: "pub-changesets",
        titleKey: "nav_publication",
        path: "publication",
        permission: "publication.read",
        icon: "publication",
        accent: "publication",
      },
      {
        id: "search",
        titleKey: "nav_search",
        path: "search",
        icon: "search",
        accent: "search",
      },
    ],
  },
  {
    id: "interactions",
    titleKey: "nav_group_interactions",
    items: [
      {
        id: "integrations-slot",
        titleKey: "nav_integrations",
        path: "integrations",
        permission: "integrations.read",
        icon: "integrations",
        accent: "integrations",
      },
      {
        id: "payments-slot",
        titleKey: "nav_payments",
        path: "payments",
        permission: "payments.read",
        icon: "payments",
        accent: "payments",
      },
    ],
  },
  {
    id: "system",
    titleKey: "nav_group_system",
    items: [
      {
        id: "theme",
        titleKey: "nav_theme",
        path: "theme",
        permission: "theme.read",
        icon: "theme",
        accent: "theme",
      },
      {
        id: "users",
        titleKey: "nav_users",
        path: "users",
        permission: "users.read",
        icon: "access",
        accent: "access",
      },
      {
        id: "analytics",
        titleKey: "analytics.screen_title",
        path: "analytics",
        permission: "analytics.read",
        icon: "search",
        accent: "system",
      },
      {
        id: "notifications",
        titleKey: "nav_notifications",
        path: "notifications",
        permission: "integrations.read",
        icon: "notifications",
        accent: "system",
      },
      {
        id: "settings",
        titleKey: "nav_settings",
        path: "settings",
        permission: "site.configure",
        icon: "settings",
        accent: "system",
      },
      {
        id: "skills",
        titleKey: "nav_skills",
        path: "skills",
        permission: "audit.read",
        icon: "code",
        accent: "system",
      },
      {
        id: "audit",
        titleKey: "nav_audit",
        path: "audit",
        permission: "audit.read",
        icon: "audit",
        accent: "audit",
      },
      {
        id: "system",
        titleKey: "nav_system",
        path: "system",
        icon: "system",
        accent: "system",
      },
    ],
  },
];

/** Which display group an extension-registered nav section merges into. */
export const SECTION_GROUP: Readonly<Record<string, string>> = {
  interactions: "interactions",
  extensions: "system",
};

/** Icon/accent for extension-registered nav items, by item id convention. */
export const EXTENSION_ITEM_ICONS: Readonly<Record<string, AdminIconName>> = {
  "interactions-forms": "forms",
  "interactions-quizzes": "quizzes",
  "interactions-submissions": "submissions",
  "interactions-quiz-runs": "quizRuns",
  "interactions-leads": "leads",
  "extensions-overview": "extensions",
};
