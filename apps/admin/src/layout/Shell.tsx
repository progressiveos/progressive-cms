// Workspace shell (PCMS-ADMIN-T001; redesign concept §8-10): Chromatic
// Workspace sidebar with domain-colored icons, global topbar (maintenance
// status, locale, appearance, account), persistent maintenance banner,
// breadcrumbs. Future modules extend it only via extension registries, never
// by rewrite.
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useBootstrap } from "../api/bootstrap.js";
import { apiDelete, apiGet, apiPut } from "../api/client.js";
import type { SessionInfo } from "../api/types.js";
import { useAuth } from "../auth/AuthContext.js";
import { ConfirmDialog, Dialog } from "../design/dialog.js";
import { Popover } from "../design/popover.js";
import {
  type AdminAppearance,
  getAppearance,
  onAppearanceChange,
  setAppearance,
} from "../design/theme.js";
import { useToast } from "../design/toast.js";
import { Tooltip } from "../design/tooltip.js";
import { accentVars, Badge, Button, EmptyState, Icon, IconButton, Spinner } from "../design/ui.js";
import { extensionNavSections } from "../extension/registry.js";
import { type AdminLocale, formatDateTime, getLocale, setLocale, t } from "../i18n/index.js";
import { NotificationPrefsDialog } from "../screens/notifications/NotificationPrefsDialog.js";
import {
  CORE_NAV,
  EXTENSION_ITEM_ICONS,
  type NavGroup,
  type NavItem,
  SECTION_GROUP,
} from "./nav.js";
import { navigate, type RouteInfo } from "./router.js";

export interface Crumb {
  readonly title: string;
  readonly path?: string;
}

/* --- Sidebar preferences --- */

const SIDEBAR_KEY = "pcms.admin.sidebar";

function getSidebarCompact(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "compact";
  } catch {
    return false;
  }
}

function setSidebarCompact(compact: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, compact ? "compact" : "expanded");
  } catch {
    // preference is best-effort
  }
}

/** t() with plain-string fallback for extension-provided titles. */
function navTitle(titleKey: string): string {
  const translated = t(titleKey);
  return translated === `[${titleKey}]` ? titleKey : translated;
}

/* --- Navigation model: core groups + extension sections merged by group --- */

function useNavGroups(can: (permission?: string) => boolean): readonly NavGroup[] {
  const groups: { id: string; titleKey: string; items: NavItem[] }[] = CORE_NAV.map((group) => ({
    ...group,
    items: [...group.items],
  }));
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const section of extensionNavSections()) {
    const target = byId.get(SECTION_GROUP[section.id] ?? "system");
    if (target === undefined) continue;
    for (const item of section.items) {
      target.items.push({
        id: item.id,
        titleKey: item.title,
        path: item.path,
        ...(item.permission === undefined ? {} : { permission: item.permission }),
        icon: EXTENSION_ITEM_ICONS[item.id] ?? "menu",
        accent: "interactions",
      });
    }
  }
  return (
    groups
      // An item WITHOUT a permission has no requirement (extension UI
      // contributions, ADR-0017 S6) — ACL still enforced server-side.
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.permission === undefined || can(item.permission)),
      }))
      .filter((group) => group.items.length > 0)
  );
}

function NavLink(props: {
  readonly item: NavItem;
  readonly route: RouteInfo;
  readonly compact: boolean;
}) {
  const href = `#/${props.item.path}`;
  const current =
    props.route.segments[0] === props.item.path ||
    (props.item.path === "content" && props.route.path === "/");
  const link = (
    <a
      className="pcms-nav__link"
      style={accentVars(props.item.accent)}
      href={href}
      aria-current={current ? "page" : undefined}
      data-active={current ? "true" : undefined}
      data-testid={`nav-${props.item.id}`}
    >
      <Icon name={props.item.icon} className="pcms-nav__icon" />
      <span className="pcms-nav__label">{navTitle(props.item.titleKey)}</span>
    </a>
  );
  if (!props.compact) return link;
  return (
    <Tooltip content={navTitle(props.item.titleKey)} placement="right">
      {link}
    </Tooltip>
  );
}

function Sidebar(props: {
  readonly route: RouteInfo;
  readonly groups: readonly NavGroup[];
  readonly compact: boolean;
}) {
  // The site title under the logo (owner 2026-10-08): with several admin
  // tabs open it must be obvious WHICH site this console controls.
  const bootstrap = useBootstrap();
  const siteTitle = bootstrap?.site.title ?? "";
  return (
    <div className="pcms-sidebar__inner">
      <div className="pcms-sidebar__brand-row">
        <a className="pcms-sidebar__brand" href="#/" aria-label="Progressive CMS">
          <img
            className="pcms-sidebar__mark"
            src="/admin/brand/pcms-logo-2026.svg"
            alt=""
            aria-hidden="true"
          />
          <span className="pcms-sidebar__brand-text">
            <span className="pcms-sidebar__wordmark">Progressive CMS</span>
            <span className="pcms-sidebar__sitename">{siteTitle}</span>
          </span>
        </a>
        <a
          className="pcms-sidebar__eye"
          href="/"
          target="_blank"
          rel="noreferrer"
          aria-label={t("open_site_title")}
          title={t("open_site_title")}
          data-testid="sidebar-open-site"
        >
          <Icon name="openSite" className="pcms-sidebar__eye-icon" />
        </a>
      </div>
      <nav className="pcms-sidebar__nav" aria-label={t("nav_label")}>
        {props.groups.map((group) => (
          <div key={group.id} className="pcms-sidebar__group">
            {group.items.length === 1 ? null : (
              <div className="pcms-sidebar__group-title">{t(group.titleKey)}</div>
            )}
            {group.items.map((item) => (
              <NavLink key={item.id} item={item} route={props.route} compact={props.compact} />
            ))}
          </div>
        ))}
      </nav>
    </div>
  );
}

/* --- Topbar controls --- */

interface MaintenanceWire {
  readonly configured: boolean;
  readonly enabled?: boolean;
}

function useMaintenance(enabledPermission: boolean) {
  const [state, setState] = useState<MaintenanceWire | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    if (!enabledPermission) return;
    apiGet<MaintenanceWire>("/maintenance")
      .then((wire) => {
        setState(wire);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [enabledPermission]);

  useEffect(() => {
    reload();
    if (!enabledPermission) return undefined;
    const interval = window.setInterval(reload, 60_000);
    return () => window.clearInterval(interval);
  }, [reload, enabledPermission]);

  return { state, failed, reload };
}

type MaintenanceAction = { readonly enable: boolean } | null;

function MaintenanceControl(props: {
  readonly enabledPermission: boolean;
  readonly requestToggle: (action: MaintenanceAction) => void;
}) {
  const { state, failed } = useMaintenance(props.enabledPermission);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (!props.enabledPermission) return null;

  const statusNode = <MaintenanceStatus state={state} failed={failed} />;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="pcms-topbar__control pcms-topbar__control--status"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="maintenance-status"
        onClick={() => setOpen((value) => !value)}
      >
        {statusNode}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={buttonRef.current} align="end">
        <div className="pcms-maintenance__popover">
          {statusNode}
          {state?.enabled === true ? (
            <Button
              size="sm"
              onClick={() => {
                setOpen(false);
                props.requestToggle({ enable: false });
              }}
            >
              {t("maintenance_turn_off")}
            </Button>
          ) : null}
          <a className="pcms-maintenance__details" href="#/maintenance">
            {t("maintenance_details")}
          </a>
        </div>
      </Popover>
    </>
  );
}

function MaintenanceStatus(props: {
  readonly state: MaintenanceWire | null;
  readonly failed: boolean;
}) {
  if (props.failed || props.state === null || props.state.enabled === undefined) {
    return (
      <span className="pcms-maintenance__status">
        <Icon name="warning" className="pcms-maintenance__icon pcms-maintenance__icon--warn" />
        <span className="pcms-maintenance__label">{t("maintenance_unknown_status")}</span>
      </span>
    );
  }
  if (props.state.enabled) {
    return (
      <span className="pcms-maintenance__status pcms-maintenance__status--on">
        <Icon name="maintenance" className="pcms-maintenance__icon" />
        <span className="pcms-maintenance__label">{t("maintenance_on_status")}</span>
      </span>
    );
  }
  return (
    <span className="pcms-maintenance__status">
      <span className="pcms-maintenance__dot" aria-hidden="true" />
      <span className="pcms-maintenance__label">{t("maintenance_off_status")}</span>
    </span>
  );
}

function ThemeControl() {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [preference, setPreference] = useState<AdminAppearance>(() => getAppearance());
  useEffect(() => onAppearanceChange((next) => setPreference(next)), []);
  const effective =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  const icon = preference === "system" ? "monitor" : effective === "dark" ? "moon" : "sun";
  const options: readonly { readonly value: AdminAppearance; readonly label: string }[] = [
    { value: "light", label: t("theme_light") },
    { value: "dark", label: t("theme_dark") },
    { value: "system", label: t("theme_system") },
  ];
  return (
    <>
      <IconButton
        ref={buttonRef}
        icon={icon}
        label={t("topbar_theme")}
        testid="theme-control"
        onClick={() => setOpen((value) => !value)}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchor={buttonRef.current} align="end">
        <div role="menu" aria-label={t("topbar_theme")}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={preference === option.value}
              className="pcms-menu__item pcms-menu__item--row"
              onClick={() => {
                setAppearance(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {preference === option.value ? <Icon name="check" /> : null}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function LocaleControl() {
  const current = getLocale();
  const switchTo = (locale: AdminLocale) => {
    if (locale !== current) setLocale(locale);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: segmented control, not a fieldset
    <div
      className="pcms-locale"
      role="group"
      aria-label={t("topbar_locale")}
      data-testid="locale-switch"
    >
      <button
        type="button"
        className="pcms-locale__option"
        aria-pressed={current === "ru"}
        onClick={() => switchTo("ru")}
      >
        RU
      </button>
      <button
        type="button"
        className="pcms-locale__option"
        aria-pressed={current === "en"}
        onClick={() => switchTo("en")}
      >
        EN
      </button>
    </div>
  );
}

function SessionsDialog(props: { readonly open: boolean; readonly onClose: () => void }) {
  const toast = useToast();
  const [sessions, setSessions] = useState<readonly SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setSessions(null);
    setError(null);
    apiGet<{ items: readonly SessionInfo[] }>("/auth/sessions")
      .then((result) => setSessions(result.items))
      .catch(() => setError(t("error_title")));
  }, [props.open]);

  const revoke = async (sessionId: string) => {
    try {
      await apiDelete(`/auth/sessions/${sessionId}`);
      setSessions(
        (current) => current?.filter((session) => session.session_id !== sessionId) ?? null,
      );
      toast(t("saved"), "success");
    } catch {
      toast(t("error_title"), "error");
    }
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} title={t("account_sessions")}>
      {error !== null ? (
        <EmptyState title={error} />
      ) : sessions === null ? (
        <Spinner />
      ) : (
        <ul className="pcms-session-list">
          {sessions.map((session) => (
            <li key={session.session_id}>
              <div>
                <div>{formatDateTime(session.created_at)}</div>
                <div className="pcms-text-muted">{formatDateTime(session.last_seen_at)}</div>
              </div>
              {session.current ? (
                <Badge tone="accent">
                  <Icon name="check" label={t("shell.current_session")} />
                </Badge>
              ) : (
                <Button size="sm" onClick={() => void revoke(session.session_id)}>
                  {t("delete")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function Shell(props: {
  readonly route: RouteInfo;
  readonly crumbs: readonly Crumb[];
  readonly children: ReactNode;
}) {
  const auth = useAuth();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [compact, setCompact] = useState(getSidebarCompact);
  const [toggleAction, setToggleAction] = useState<MaintenanceAction>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const accountButtonRef = useRef<HTMLButtonElement | null>(null);

  const can = (permission?: string) => permission === undefined || auth.can(permission);
  const canMaintenance = can("site.maintenance");
  const { state: maintenanceState, reload: reloadMaintenance } = useMaintenance(canMaintenance);
  const groups = useNavGroups(can);
  const actor = auth.state.status === "authed" ? auth.state.actor : null;

  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [menuOpen]);

  const runToggle = async () => {
    if (toggleAction === null) return;
    const enable = toggleAction.enable;
    setToggleBusy(true);
    setToggleError(null);
    try {
      await apiPut("/maintenance", { enabled: enable });
      setToggleAction(null);
      reloadMaintenance();
      toast(
        enable ? t("maintenance_on_status") : t("maintenance_off_status"),
        enable ? "warning" : "success",
      );
    } catch (error) {
      setToggleError(error instanceof Error ? error.message : String(error));
    } finally {
      setToggleBusy(false);
    }
  };

  const maintenanceOn = canMaintenance && maintenanceState?.enabled === true;

  return (
    <div className={compact ? "pcms-shell pcms-shell--compact" : "pcms-shell"}>
      {/* biome-ignore lint/a11y/useValidAnchor: a skip link is real in-page
          navigation (href target), the handler only moves SPA focus to the
          main landmark — the anchor semantics are exactly what a11y wants. */}
      <a
        className="pcms-skip-link"
        href="#pcms-main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("pcms-main")?.focus();
        }}
      >
        {t("skip_to_content")}
      </a>
      {mobileNavOpen ? (
        <div
          className="pcms-mobile-nav-overlay"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      {/* Links emit click for both pointer and keyboard activation. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: delegate activation from native links */}
      <aside
        className={mobileNavOpen ? "pcms-sidebar pcms-sidebar--open" : "pcms-sidebar"}
        onClick={(event) => {
          if ((event.target as Element).closest("a")) setMobileNavOpen(false);
        }}
      >
        <Sidebar route={props.route} groups={groups} compact={compact} />
        <div className="pcms-sidebar__footer">
          <IconButton
            icon="sidebar"
            label={compact ? t("sidebar_expand") : t("sidebar_collapse")}
            testid="sidebar-toggle"
            onClick={() => {
              setCompact(!compact);
              setSidebarCompact(!compact);
            }}
          />
        </div>
      </aside>
      <div className="pcms-shell__body">
        <header className="pcms-topbar">
          <IconButton
            icon="menu"
            label={t("open_menu")}
            className="pcms-topbar__burger"
            testid="mobile-nav"
            onClick={() => setMobileNavOpen((value) => !value)}
          />
          <nav aria-label={t("breadcrumbs_label")} className="pcms-crumbs">
            {props.crumbs.map((crumb, index) => (
              <span key={`${crumb.path ?? "leaf"}:${crumb.title}`} className="pcms-crumbs__item">
                {index > 0 ? <span aria-hidden="true">/ </span> : null}
                {crumb.path === undefined ? (
                  <span aria-current={index === props.crumbs.length - 1 ? "location" : undefined}>
                    {crumb.title}
                  </span>
                ) : (
                  <a href={`#/${crumb.path}`}>{crumb.title}</a>
                )}
              </span>
            ))}
          </nav>
          <div className="pcms-topbar__spacer" />
          <a className="pcms-topbar__control" href="#/search" data-testid="topbar-search">
            <Icon name="search" />
          </a>
          <MaintenanceControl enabledPermission={canMaintenance} requestToggle={setToggleAction} />
          <LocaleControl />
          <ThemeControl />
          <div className="pcms-menu-wrap" ref={menuRef}>
            <Button
              ref={accountButtonRef}
              variant="ghost"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid="account-menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Icon name="account" />
            </Button>
            {menuOpen ? (
              <div className="pcms-menu" role="menu">
                {actor === null ? null : (
                  <div className="pcms-menu__note">
                    {actor.actor_type === "USER"
                      ? t("account_actor_user")
                      : t("account_actor_service")}
                  </div>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="pcms-menu__item"
                  onClick={() => {
                    setMenuOpen(false);
                    setPrefsOpen(true);
                  }}
                >
                  {t("account_notifications")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="pcms-menu__item"
                  onClick={() => {
                    setMenuOpen(false);
                    setSessionsOpen(true);
                  }}
                >
                  {t("account_sessions")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="pcms-menu__item pcms-menu__item--danger"
                  onClick={() => {
                    setMenuOpen(false);
                    // The menu item unmounts with the menu; hand focus back
                    // to the trigger synchronously so the dialog's own focus
                    // restore returns here on close.
                    accountButtonRef.current?.focus();
                    setLogoutOpen(true);
                  }}
                >
                  {t("account_logout")}
                </button>
              </div>
            ) : null}
          </div>
        </header>
        {maintenanceOn ? (
          <div className="pcms-maintenance-banner" role="status" data-testid="maintenance-banner">
            <Icon name="maintenance" className="pcms-maintenance-banner__icon" />
            <span className="pcms-maintenance-banner__text">
              <strong>{t("maintenance_banner_title")}</strong> {t("maintenance_banner_text")}
            </span>
            <span className="pcms-maintenance-banner__actions">
              <a href="#/maintenance">{t("maintenance_details")}</a>
              {canMaintenance ? (
                <button type="button" onClick={() => setToggleAction({ enable: false })}>
                  {t("maintenance_turn_off")}
                </button>
              ) : null}
            </span>
          </div>
        ) : null}
        <main id="pcms-main" className="pcms-main" tabIndex={-1}>
          {props.children}
        </main>
        <footer className="pcms-copyright">
          <a href={t("copyright_url")} target="_blank" rel="noreferrer">
            {t("copyright_label")}
          </a>
        </footer>
      </div>
      <SessionsDialog open={sessionsOpen} onClose={() => setSessionsOpen(false)} />
      <NotificationPrefsDialog
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        isUser={actor?.actor_type === "USER"}
      />
      <ConfirmDialog
        open={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        onConfirm={() => {
          setLogoutOpen(false);
          void logout();
        }}
        title={t("logout_confirm_title")}
        confirmLabel={t("logout_confirm")}
        tone="danger"
      />
      <ConfirmDialog
        open={toggleAction !== null}
        onClose={() => {
          setToggleAction(null);
          setToggleError(null);
        }}
        onConfirm={() => void runToggle()}
        title={
          toggleAction?.enable === true
            ? t("maintenance_enable_confirm_title")
            : t("maintenance_disable_confirm_title")
        }
        body={
          toggleAction?.enable === true
            ? t("maintenance_enable_confirm_body")
            : t("maintenance_disable_confirm_body")
        }
        confirmLabel={
          toggleAction?.enable === true
            ? t("maintenance_enable_action")
            : t("maintenance_disable_action")
        }
        tone={toggleAction?.enable === true ? "primary" : "danger"}
        busy={toggleBusy}
        error={toggleError}
      />
    </div>
  );

  async function logout() {
    try {
      await auth.logout();
      navigate("/", { replace: true });
    } catch {
      toast(t("error_title"), "error");
    }
  }
}
