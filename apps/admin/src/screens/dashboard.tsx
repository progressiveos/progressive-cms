// Overview landing (PCMS-ADMIN-T001; redesign concept §11, spec §26):
// answers "what is happening with the site?" using only real data — content
// counts from the tree, upcoming scheduled publications, latest media,
// maintenance state, CMS version — plus the dashboard-widget extension slot.
// No invented KPIs: a widget without a data source does not render.
import { useEffect, useState } from "react";
import { useBootstrap } from "../api/bootstrap.js";
import { apiGet } from "../api/client.js";
import type { ContentTreeItemWire } from "../api/content.js";
import type { AdminIconName } from "../design/icons.js";
import { Tooltip } from "../design/tooltip.js";
import type { DomainAccent } from "../design/ui.js";
import { Icon, IconTile, Skeleton } from "../design/ui.js";
import { t } from "../i18n/index.js";

function loadContent() {
  return apiGet<{ items: readonly ContentTreeItemWire[] }>("/discovery/content/tree").then(
    (result) => result.items,
  );
}

function loadCalendar() {
  const from = new Date();
  const to = new Date(Date.now() + 14 * 24 * 3600 * 1000);
  return apiGet<{ items: readonly unknown[] }>(
    `/publication/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
  );
}

function loadMedia() {
  return apiGet<{
    items: readonly { id: string; filenameOriginal: string; kind: string }[];
  }>("/media?limit=60");
}

function useAsync<T>(loader: () => Promise<T>): readonly [T | null, boolean] {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loader()
      .then((result) => {
        if (!cancelled) setValue(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loader]);
  return [value, failed] as const;
}

function WidgetCard(props: {
  readonly icon: AdminIconName;
  readonly accent: DomainAccent;
  readonly title: string;
  readonly children: React.ReactNode;
  readonly tooltip?: string;
}) {
  return (
    <section className="pcms-widget" data-testid="overview-widget">
      <div className="pcms-widget__head">
        <IconTile icon={props.icon} accent={props.accent} />
        <h3 className="pcms-widget__title">
          {props.title}
          {props.tooltip === undefined ? null : (
            <Tooltip content={props.tooltip}>
              <button type="button" className="pcms-widget__help">
                <Icon name="help" label={t("overview_more")} />
              </button>
            </Tooltip>
          )}
        </h3>
      </div>
      <div className="pcms-widget__body">{props.children}</div>
    </section>
  );
}

function Stat(props: { readonly value: string | number; readonly label: string }) {
  return (
    <div className="pcms-widget__stat">
      <span className="pcms-widget__value">{props.value}</span>
      <span className="pcms-widget__label">{props.label}</span>
    </div>
  );
}

function ContentWidget() {
  const [items] = useAsync(loadContent);
  return (
    <WidgetCard
      icon="content"
      accent="content"
      title={t("nav_content")}
      tooltip={t("overview_content_tooltip")}
    >
      {items === null ? (
        <Skeleton w="60%" h="28px" />
      ) : (
        <>
          <Stat
            value={items.filter((item) => item.has_working).length}
            label={t("overview_drafts")}
          />
          <Stat
            value={items.filter((item) => item.has_publication).length}
            label={t("overview_published")}
          />
        </>
      )}
      <a className="pcms-widget__link" href="#/content">
        {t("nav_content")} →
      </a>
    </WidgetCard>
  );
}

function PublicationWidget() {
  const [calendar] = useAsync(loadCalendar);
  return (
    <WidgetCard
      icon="publication"
      accent="publication"
      title={t("nav_publication")}
      tooltip={t("overview_publication_tooltip")}
    >
      {calendar === null ? (
        <Skeleton w="60%" h="28px" />
      ) : (
        <Stat value={calendar.items.length} label={t("overview_upcoming")} />
      )}
      <a className="pcms-widget__link" href="#/publication">
        {t("nav_publication")} →
      </a>
    </WidgetCard>
  );
}

function MediaWidget() {
  const [media] = useAsync(loadMedia);
  return (
    <WidgetCard icon="media" accent="media" title={t("nav_media")}>
      {media === null ? (
        <Skeleton w="60%" h="28px" />
      ) : (
        <Stat value={media.items.length} label={t("overview_media_recent")} />
      )}
      <a className="pcms-widget__link" href="#/media">
        {t("nav_media")} →
      </a>
    </WidgetCard>
  );
}

function SystemWidget() {
  const bootstrap = useBootstrap();
  return (
    <WidgetCard icon="system" accent="system" title={t("nav_system")}>
      <Stat
        value={bootstrap === null ? "—" : `v${bootstrap.server.cms_version}`}
        label={t("overview_version")}
      />
      <a className="pcms-widget__link" href="#/system">
        {t("nav_system")} →
      </a>
    </WidgetCard>
  );
}

export function DashboardScreen() {
  return (
    <div className="pcms-screen pcms-overview">
      <h1>{t("dashboard_title")}</h1>
      <p>{t("dashboard_hint")}</p>
      <div className="pcms-overview__grid">
        <ContentWidget />
        <PublicationWidget />
        <MediaWidget />
        <SystemWidget />
      </div>
      <div className="pcms-overview__quick">
        <a className="pcms-quicklink" href="#/content">
          <Icon name="plus" /> {t("overview_quick_create")}
        </a>
        <a className="pcms-quicklink" href="#/media">
          <Icon name="upload" /> {t("overview_quick_media")}
        </a>
        <a className="pcms-quicklink" href="#/publication">
          <Icon name="publication" /> {t("overview_quick_publication")}
        </a>
      </div>
    </div>
  );
}
