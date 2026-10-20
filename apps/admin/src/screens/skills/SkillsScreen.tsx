// Community skills screen (Community Skills plan §4): list both roots with
// origin badges, install from URL/file, sample download, disable/enable/
// uninstall. Management gates on skills.manage; first-party skills are
// listed read-only (they ship with the release).
//
// The second tab "Repository" (Community Registry plan §4) is the registry
// client surface: package catalog with one-click install of approved
// skills, engine releases with update button, and publishing of installed
// community skills. The server (packages/api) owns SSRF guards and the
// security-check pipeline — the tab only reflects package check states.

import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { fetchBootstrapInfo, refreshBootstrap, useBootstrap } from "../../api/bootstrap.js";
import { ApiError, apiDelete, apiPost, apiPostRaw } from "../../api/client.js";
import {
  applyRegistryUpdate,
  confirmRegistryInstance,
  fetchRegistryIndex,
  fetchRegistryInstance,
  fetchRegistryInstanceStatus,
  fetchUpdateStatus,
  installRegistryPackage,
  publishSkillToRegistry,
  type RegistryIndex,
  type RegistryInstanceStatus,
  type RegistryPackageIndexItem,
  type RegistryPublishResult,
  type RegistryUpdateResult,
} from "../../api/registry.js";
import {
  disableSkill,
  enableSkill,
  fetchSkills,
  installSkillFile,
  installSkillUrl,
  type SkillListItem,
  uninstallSkill,
} from "../../api/skills.js";
import { useAuth } from "../../auth/AuthContext.js";
import { Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import { Tooltip } from "../../design/tooltip.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  Input,
  Spinner,
  TabPanel,
  Tabs,
} from "../../design/ui.js";
import { t } from "../../i18n/index.js";

/** Registry check status → badge tone (approved packages are installable). */
function checkTone(check: string): "success" | "warning" | "danger" {
  if (check === "approved") return "success";
  if (check === "pending") return "warning";
  return "danger";
}

function checkLabel(check: string): string {
  if (check === "approved") return t("registry.check_approved");
  if (check === "pending") return t("registry.check_pending");
  return t("registry.check_rejected");
}

function RegistryPackageCard(props: {
  readonly pkg: RegistryPackageIndexItem;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly onInstall: (pkg: RegistryPackageIndexItem) => void;
}) {
  const { pkg } = props;
  const installable =
    pkg.check === "approved" &&
    (pkg.kind === "skill" || pkg.kind === "extension" || pkg.kind === "theme") &&
    pkg.download_url !== null &&
    props.canManage;
  return (
    <Card title={`${pkg.id} ${pkg.version}`}>
      <p>
        <Badge tone={pkg.kind === "skill" ? "info" : pkg.kind === "theme" ? "accent" : "violet"}>
          {pkg.kind === "skill"
            ? t("registry.kind_skill")
            : pkg.kind === "theme"
              ? t("registry.kind_theme")
              : t("registry.kind_extension")}
        </Badge>{" "}
        <Badge tone={checkTone(pkg.check)}>{checkLabel(pkg.check)}</Badge>{" "}
        <Badge tone={pkg.price === null || pkg.price === 0 ? "neutral" : "accent"}>
          {pkg.price === null || pkg.price === 0 ? t("registry.price_free") : String(pkg.price)}
        </Badge>
      </p>
      {pkg.summary === "" ? null : <p>{pkg.summary}</p>}
      <p className="pcms-field__hint">
        {t("registry.author_line", { author: pkg.author })} ·{" "}
        {t("registry.updated_line", { updated: pkg.updated })}
      </p>
      {installable ? (
        <Button
          size="sm"
          disabled={props.busy}
          data-testid={`registry-install-${pkg.id}`}
          onClick={() => props.onInstall(pkg)}
        >
          {t("registry.install")}
        </Button>
      ) : null}
    </Card>
  );
}

function RegistryTab(props: {
  readonly canManage: boolean;
  readonly communitySkills: readonly SkillListItem[] | null;
  readonly reloadSkills: () => void;
  /** "updates" = releases + binding + manual upload (first tab); "catalog" =
   * package catalog + publish (second tab). One component, two views —
   * shared loading/error/binding plumbing (ponytail: no third file). */
  readonly view: "updates" | "catalog";
}) {
  const toast = useToast();
  const bootstrap = useBootstrap();
  const [index, setIndex] = useState<RegistryIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishId, setPublishId] = useState("");
  const [publishResult, setPublishResult] = useState<RegistryPublishResult | null>(null);
  // Registry v2 binding: the instance code is stable and NOT secret; the
  // owner claims it in the account area, then confirms here (per-instance token issued
  // to this CMS, stored encrypted, never displayed).
  const [instance, setInstance] = useState<{ code: string } | null>(null);
  const [instanceStatus, setInstanceStatus] = useState<RegistryInstanceStatus | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    setNotConfigured(false);
    fetchRegistryIndex()
      .then(setIndex)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        if (err instanceof ApiError) {
          if (err.code === "REGISTRY_UNAUTHORIZED") setUnauthorized(true);
          if (err.code === "REGISTRY_NOT_CONFIGURED") setNotConfigured(true);
        }
      });
    fetchRegistryInstance()
      .then((instanceInfo) => {
        setInstance({ code: instanceInfo.instance_code });
        return fetchRegistryInstanceStatus().then(setInstanceStatus);
      })
      .catch(() => {
        setInstance(null);
        setInstanceStatus(null);
      });
  }, []);
  useEffect(reload, [reload]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const install = (pkg: RegistryPackageIndexItem): Promise<void> =>
    run(async () => {
      if (pkg.download_url === null) return;
      if (pkg.kind === "theme") {
        await apiPost("/themes/install", { download_url: pkg.download_url });
      } else {
        await installRegistryPackage(pkg.download_url);
        props.reloadSkills();
      }
      toast(t("registry.installed_toast", { id: pkg.id }), "success");
    });

  const applyUpdate = (version: string): Promise<void> =>
    run(async () => {
      // Async apply (0.1.194): the POST returns RUNNING immediately, the
      // heavy work continues detached, and pcms_update_history carries the
      // outcome. The SERVER record is the only arbiter — never the shape of
      // a proxied response body (p-cms.ru 2026-10-07).
      await applyRegistryUpdate(version);
      const recordDeadline = Date.now() + 180_000;
      let outcome: "SUCCEEDED" | "FAILED" | null = null;
      let failureCode: string | null = null;
      while (Date.now() < recordDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        try {
          const status = await fetchUpdateStatus();
          const record = status.update;
          if (record !== null && record.to_version === version && record.status !== "RUNNING") {
            outcome = record.status;
            failureCode = record.failure_code;
            break;
          }
        } catch {
          // transport hiccup (the web unit restarts mid-poll) — keep polling
        }
      }
      if (outcome === null) {
        throw new Error(t("registry.update_pending_toast"));
      }
      if (outcome === "FAILED") {
        throw new Error(`${failureCode ?? "UPDATE_FAILED"} — ${t("registry.update_failed_toast")}`);
      }
      // The web unit restarts on an ~8s fuse AFTER the record completes;
      // hold the toast until the running server confirms the new version,
      // then refresh the badge without a manual page reload.
      const switchDeadline = Date.now() + 45_000;
      while (Date.now() < switchDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        try {
          if ((await fetchBootstrapInfo()).server.cms_version === version) break;
        } catch {
          // mid-restart — keep asking
        }
      }
      await refreshBootstrap().catch(() => {});
      toast(t("registry.update_applied_toast", { version }), "success");
      reload();
    });

  const publish = (): Promise<void> =>
    run(async () => {
      if (publishId === "") return;
      const result = await publishSkillToRegistry(publishId);
      setPublishResult(result);
      toast(t("registry.publish_result", { id: result.id }), "success");
    });

  const confirmBinding = (): Promise<void> =>
    run(async () => {
      const result = await confirmRegistryInstance();
      toast(t("registry.instance_bound_toast", { email: result.account_email }), "success");
      const status = await fetchRegistryInstanceStatus();
      setInstanceStatus(status);
    });

  // Account-token UI removed (owner 2026-10-06): the instance binding alone
  // opens the catalog and updates — the token is only an API-level fallback,
  // and the field confused operators into thinking it was required. Recovery
  // path is rebind (unbind in the account area → claim → Confirm binding).

  // Manual release upload works on ANY instance (owner 2026-10-08): binding
  // is only about AUTOMATIC registry updates. The hint names the instance
  // code so the operator can register right from here.
  const manualUpload =
    props.canManage && props.view === "updates" ? (
      <>
        <RegistryBindingCard
          busy={busy}
          instance={instance}
          instanceStatus={instanceStatus}
          unauthorized={unauthorized}
          onConfirm={confirmBinding}
        />
        <ReleaseUpload busy={busy} instanceCode={instance?.code ?? null} />
      </>
    ) : null;

  if (index === null) {
    if (error === null) return <Spinner label={t("registry.loading")} />;
    // REGISTRY_NOT_CONFIGURED = no registry.baseUrl — binding is impossible,
    // the quiet setup card is the honest answer.
    if (notConfigured) {
      return (
        <>
          <Card title={t("registry.not_configured_title")}>
            <p>{t("registry.not_configured_text")}</p>
            <p>
              <a href="https://skills.p-cms.ru" target="_blank" rel="noreferrer">
                {t("registry.docs_link")}
              </a>
            </p>
          </Card>
          {manualUpload}
        </>
      );
    }
    // Degraded view (2026-10-05 incident): catalog failed (e.g. revoked
    // tokens → REGISTRY_UNAUTHORIZED) but the binding data is INDEPENDENT of
    // the catalog — the rebind + account-token block MUST stay reachable.
    return (
      <div data-testid="registry-tab-degraded">
        <ErrorPanel message={error} onRetry={reload} />
        {manualUpload}
      </div>
    );
  }
  if (!index.configured) {
    // Quiet notice: the operator must set registry.baseUrl + the token slot
    // for AUTOMATIC updates — but the manual upload below works regardless
    // (owner 2026-10-08).
    return (
      <>
        <Card title={t("registry.not_configured_title")}>
          <p>{t("registry.not_configured_text")}</p>
          <p>
            <a href="https://skills.p-cms.ru" target="_blank" rel="noreferrer">
              {t("registry.docs_link")}
            </a>
          </p>
        </Card>
        {manualUpload}
      </>
    );
  }

  const skills = props.communitySkills ?? [];
  return (
    <div data-testid="registry-tab">
      {error !== null ? <ErrorPanel message={error} onRetry={reload} /> : null}

      {props.view === "catalog" ? (
        <>
          <h3 className="pcms-admin-h4" style={{ margin: "16px 0 8px" }}>
            {t("registry.catalog_title")}
          </h3>
          {index.packages.length === 0 ? (
            <EmptyState title={t("registry.empty_title")} hint={t("registry.empty_hint")} />
          ) : (
            <div className="pcms-card-grid">
              {index.packages.map((pkg) => (
                <RegistryPackageCard
                  key={`${pkg.kind}:${pkg.id}`}
                  pkg={pkg}
                  canManage={props.canManage}
                  busy={busy}
                  onInstall={install}
                />
              ))}
            </div>
          )}
        </>
      ) : null}

      {props.view === "updates" ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t("registry.releases_title")}>
            {index.releases.length === 0 ? (
              <p className="pcms-field__hint">{t("registry.releases_empty")}</p>
            ) : (
              <div className="pcms-table-wrap">
                <table className="pcms-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>{t("registry.col_version")}</th>
                      <th>{t("registry.col_sha256")}</th>
                      <th>{t("registry.col_notes")}</th>
                      {props.canManage ? <th>{t("registry.col_actions")}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {index.releases.map((release) => (
                      <tr key={release.version}>
                        <td>{release.version}</td>
                        <td>
                          <code>{release.sha256.slice(0, 12)}</code>…
                        </td>
                        <td>{release.notes}</td>
                        {props.canManage ? (
                          <td>
                            {release.version === (bootstrap?.server.cms_version ?? "") ? (
                              <Badge tone="success">{t("registry.update_not_required")}</Badge>
                            ) : (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => void applyUpdate(release.version)}
                              >
                                {busy
                                  ? t("registry.update_running")
                                  : t("registry.update_to_version")}
                              </Button>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {props.canManage ? (
              <RegistryBindingCard
                busy={busy}
                instance={instance}
                instanceStatus={instanceStatus}
                unauthorized={unauthorized}
                onConfirm={confirmBinding}
              />
            ) : null}
            <p className="pcms-field__hint">{t("registry.update_restart_hint")}</p>
            {props.canManage ? (
              <ReleaseUpload busy={busy} instanceCode={instance?.code ?? null} />
            ) : null}
          </Card>
        </div>
      ) : null}

      {props.canManage && props.view === "catalog" ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t("registry.publish_title")}>
            {skills.length === 0 ? (
              <p className="pcms-field__hint">{t("registry.publish_empty")}</p>
            ) : (
              <div
                className="pcms-toolbar"
                style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}
              >
                <select
                  className="pcms-select"
                  aria-label={t("registry.publish_skill_label")}
                  value={publishId}
                  onChange={(event) => setPublishId(event.target.value)}
                >
                  <option value="">{t("registry.publish_pick")}</option>
                  {skills.map((skill) => (
                    <option key={skill.id} value={skill.id}>
                      {skill.id} ({skill.version})
                    </option>
                  ))}
                </select>
                <Button disabled={busy || publishId === ""} onClick={() => void publish()}>
                  {t("registry.publish_button")}
                </Button>
              </div>
            )}
            {publishResult !== null ? (
              <p role="status">
                <Badge tone="warning">{checkLabel(publishResult.check)}</Badge>{" "}
                {t("registry.publish_result", { id: publishResult.id })}
              </p>
            ) : null}
            <p className="pcms-field__hint">{t("registry.publish_scan_hint")}</p>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

export default function SkillsScreen() {
  const { can } = useAuth();
  const canManage = can("skills.manage");
  const toast = useToast();
  const [active, setActive] = useState("updates");
  const [items, setItems] = useState<readonly SkillListItem[] | null>(null);
  const [communityEnabled, setCommunityEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(() => {
    setError(null);
    fetchSkills()
      .then((result) => {
        setItems(result.items);
        setCommunityEnabled(result.community_enabled);
      })
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(reload, [reload]);

  const withBusy = async (action: () => Promise<void>, successKey: string): Promise<void> => {
    setBusy(true);
    try {
      await action();
      toast(t(successKey), "success");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const communitySkills =
    items === null ? null : items.filter((item) => item.origin === "community");

  return (
    <div className="pcms-screen" data-testid="skills-screen">
      <div className="pcms-toolbar">
        <h1>{t("skills.title")}</h1>
      </div>
      <Tabs
        label={t("skills.tabs_label")}
        active={active}
        onSelect={setActive}
        items={[
          { id: "updates", title: t("registry.tab_title_updates") },
          { id: "skills", title: t("skills.tab_title") },
          { id: "catalog", title: t("registry.tab_title") },
        ]}
      />
      <TabPanel id="skills" active={active === "skills"}>
        <p className="pcms-field__hint">{t("skills.hint")}</p>
        {error !== null && (
          <p className="pcms-field__hint" style={{ color: "var(--pcms-danger, #c00)" }}>
            {error}
          </p>
        )}

        {canManage && (
          <div
            className="pcms-toolbar"
            style={{ gap: "8px", alignItems: "center", flexWrap: "wrap" }}
          >
            <a href="/api/v1/skills/sample.zip" download style={{ textDecoration: "none" }}>
              <Button size="sm">{t("skills.sample")}</Button>
            </a>
            {communityEnabled ? (
              <>
                <Input
                  placeholder={t("skills.url_placeholder")}
                  value={url}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setUrl(event.target.value)}
                  style={{ flex: "1 1 18rem", minWidth: 0 }}
                />
                <Button
                  size="sm"
                  disabled={busy || url === ""}
                  onClick={() =>
                    void withBusy(async () => {
                      await installSkillUrl(url);
                      setUrl("");
                    }, "skills.installed")
                  }
                >
                  {t("skills.install_url")}
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".zip,.pcskill"
                  style={{ display: "none" }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file === undefined) return;
                    void withBusy(async () => {
                      await installSkillFile(file);
                    }, "skills.installed");
                  }}
                />
                <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
                  {t("skills.install_file")}
                </Button>
              </>
            ) : (
              <Badge tone="warning">{t("skills.community_disabled")}</Badge>
            )}
          </div>
        )}

        {items === null && error === null ? (
          <Spinner label={t("skills.loading")} />
        ) : items === null ? null : (
          <div className="pcms-table-wrap">
            <table className="pcms-table" style={{ width: "100%", marginTop: 16 }}>
              <thead>
                <tr>
                  <th>{t("skills.col_id")}</th>
                  <th>{t("skills.col_version")}</th>
                  <th>{t("skills.col_origin")}</th>
                  <th>{t("skills.col_status")}</th>
                  {canManage && <th>{t("skills.col_actions")}</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.origin}:${item.id}`}>
                    <td>{item.id}</td>
                    <td>{item.version}</td>
                    <td>
                      {item.origin === "first-party" ? (
                        <Badge tone="neutral">{t("skills.origin_first_party")}</Badge>
                      ) : (
                        <Badge tone="warning">{t("skills.origin_community")}</Badge>
                      )}
                    </td>
                    <td>
                      {item.origin === "first-party"
                        ? t("skills.status_active")
                        : item.enabled
                          ? t("skills.status_enabled")
                          : t("skills.status_disabled")}
                    </td>
                    {canManage && (
                      <td>
                        {item.origin === "community" && item.enabled && (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void withBusy(
                                async () => void (await disableSkill(item.id)),
                                "skills_disabled_toast",
                              )
                            }
                          >
                            {t("skills.action_disable")}
                          </Button>
                        )}
                        {item.origin === "community" && !item.enabled && (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void withBusy(
                                async () => void (await enableSkill(item.id)),
                                "skills_enabled_toast",
                              )
                            }
                          >
                            {t("skills.action_enable")}
                          </Button>
                        )}
                        {item.origin === "community" && (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void withBusy(
                                async () => void (await uninstallSkill(item.id)),
                                "skills.uninstalled",
                              )
                            }
                          >
                            {t("skills.action_uninstall")}
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TabPanel>
      <TabPanel id="updates" active={active === "updates"}>
        <RegistryTab
          canManage={canManage}
          communitySkills={communitySkills}
          reloadSkills={reload}
          view="updates"
        />
      </TabPanel>
      <TabPanel id="catalog" active={active === "catalog"}>
        <RegistryTab
          canManage={canManage}
          communitySkills={communitySkills}
          reloadSkills={reload}
          view="catalog"
        />
      </TabPanel>
    </div>
  );
}

/** Manual release upload (owner 2026-10-06): for deployments without a
 * registry account — download the release zip anywhere, upload it here.
 * The backend validates the embedded manifest and the version gate, stages
 * into incoming/ with the checksum sidecar and runs the standard apply;
 * the response shape matches apply-update, so the outcome toast is shared. */
function ReleaseUpload(props: { readonly busy: boolean; readonly instanceCode: string | null }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="pcms-toolbar" style={{ gap: 8, alignItems: "center", marginTop: 12 }}>
      <input
        ref={fileRef}
        type="file"
        accept=".zip"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file === undefined) return;
          setBusy(true);
          file
            .arrayBuffer()
            .then((buffer) => apiPostRaw<RegistryUpdateResult>("/registry/release-upload", buffer))
            .then((result) => {
              if (result.update?.status !== "SUCCEEDED") {
                toast(
                  `${result.update?.failure_code ?? "UPDATE_FAILED"} — ${t("registry.update_failed_toast")}`,
                  "error",
                );
                return;
              }
              toast(
                t("registry.update_applied_toast", { version: result.update.to_version ?? "" }),
                "success",
              );
            })
            .catch((err: unknown) =>
              toast(err instanceof Error ? err.message : String(err), "error"),
            )
            .finally(() => setBusy(false));
        }}
      />
      <Button size="sm" disabled={props.busy || busy} onClick={() => fileRef.current?.click()}>
        {busy ? t("registry.update_running") : t("registry.upload_release")}
      </Button>
      <span className="pcms-field__hint">{t("registry.upload_release_hint")}</span>
      <span className="pcms-field__hint">
        {props.instanceCode === null
          ? t("registry.upload_any_instance_hint_nocode")
          : t("registry.upload_any_instance_hint", { code: props.instanceCode })}
      </span>
    </div>
  );
}

/** Binding card: instance code, binding status and Confirm binding.
 * Rendered BOTH in the healthy tab and in the degraded view — a revoked
 * binding must never hide the remedy (2026-10-05 incident). The account
 * token field was removed (owner 2026-10-06): the binding alone opens the
 * catalog and updates; recovery is rebind, not a manual token. */
function RegistryBindingCard(props: {
  readonly busy: boolean;
  readonly instance: { readonly code: string } | null;
  readonly instanceStatus: RegistryInstanceStatus | null;
  readonly unauthorized: boolean;
  readonly onConfirm: () => void;
}) {
  return (
    <Card title={t("registry.binding_title")}>
      <div data-testid="registry-instance">
        <p className="pcms-toolbar">
          <Tooltip content={t("registry.instance_code_hint")}>
            <span>
              {t("registry.instance_code_label")}:{" "}
              <code>{props.instance === null ? "…" : props.instance.code}</code>
            </span>
          </Tooltip>{" "}
          {props.unauthorized ? (
            <Badge tone="warning">{t("registry.instance_unauthorized")}</Badge>
          ) : props.instanceStatus === null ? null : (
            <Badge
              tone={
                props.instanceStatus.status === "confirmed"
                  ? "success"
                  : props.instanceStatus.status === "pending"
                    ? "warning"
                    : "neutral"
              }
            >
              {t(
                props.instanceStatus.status === "confirmed"
                  ? "registry.instance_status_confirmed"
                  : props.instanceStatus.status === "pending"
                    ? "registry.instance_status_pending"
                    : props.instanceStatus.status === "unclaimed"
                      ? "registry.instance_status_unclaimed"
                      : "registry.instance_status_unknown",
                { email: props.instanceStatus.account_email ?? "" },
              )}
            </Badge>
          )}
          {props.instanceStatus?.status === "pending" ? (
            <Button
              size="sm"
              variant="primary"
              disabled={props.busy}
              onClick={() => void props.onConfirm()}
            >
              {t("registry.instance_confirm")}
            </Button>
          ) : null}
        </p>
        <span className="pcms-field__hint">{t("registry.instance_binding_hint")}</span>
      </div>
    </Card>
  );
}
