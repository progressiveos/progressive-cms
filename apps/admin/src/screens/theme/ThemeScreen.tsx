// Theme workspace (PCMS-ADMIN-T019; Admin spec §38-§40): active theme,
// settings form from the manifest schema, validation, preview pointer,
// developer info. No source editing — the theme stays a developer-owned
// source tree; only typed settings and activation live here. Installed-theme
// management (owner directive 2026-09-29): list/install (.pcTheme artifact or
// repository)/uninstall via /themes/* — the renderDir theme is protected.
import { useCallback, useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, apiRequest } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { useToast } from "../../design/toast.js";
import { Tooltip } from "../../design/tooltip.js";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Switch,
} from "../../design/ui.js";
import { t } from "../../i18n/index.js";
import type { FieldSchemaWire } from "../content/fields/registry.js";
import { MediaControl } from "../content/fields/structured.js";
import { themeSettingLabel } from "./setting-labels.js";
import { ThemeHistoryCleanup } from "./ThemeHistoryCleanup.js";

interface ManifestSetting {
  readonly key: string;
  readonly type: string;
  readonly label?: string;
  readonly token?: string;
  readonly default?: unknown;
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

interface ThemeStateWire {
  readonly activation_available: boolean;
  readonly active: { readonly theme_key: string; readonly theme_version: string } | null;
  readonly settings: {
    readonly values: Record<string, unknown>;
    readonly generation: number;
  } | null;
  readonly manifest_settings: readonly ManifestSetting[];
  readonly theme: {
    readonly theme_contract_version: string;
    readonly manifest: { readonly id: string; readonly name: string; readonly version: string };
    readonly templates: readonly { readonly id: string }[];
    readonly navigation_placements: readonly { readonly id: string; readonly max_depth: number }[];
    readonly media_presets: readonly { readonly id: string }[];
    readonly validation: {
      readonly ok: boolean;
      readonly issues?: readonly { readonly message: string }[];
    };
  } | null;
  readonly publication: { readonly pending: boolean; readonly published: boolean } | null;
}

interface InstalledThemeWire {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly is_render_target: boolean;
  readonly active: boolean;
  readonly installed_at: string | null;
  readonly source: string | null;
  readonly broken: string | null;
}

export function ThemeScreen() {
  const auth = useAuth();
  const toast = useToast();
  const [state, setState] = useState<ThemeStateWire | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Installed-theme management (repository or .pcTheme artifact).
  const [installed, setInstalled] = useState<InstalledThemeWire[] | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const installInputRef = useRef<HTMLInputElement>(null);

  // Publication CAS baseline for the publish action (0 when never published).
  const [publicationGeneration, setPublicationGeneration] = useState(0);

  const reload = useCallback(() => {
    setLoadError(null);
    apiGet<{ generation: number } | null>(
      "/publications/theme_settings/0190c0de-0000-7000-8000-517e775e7760",
    )
      .then((result) => setPublicationGeneration(result?.generation ?? 0))
      .catch(() => setPublicationGeneration(0));
    apiGet<ThemeStateWire>("/theme/state")
      .then((result) => {
        setState(result);
        setValues(
          (result.settings?.values ?? defaultValues(result.manifest_settings)) as Record<
            string,
            unknown
          >,
        );
        setGeneration(result.settings?.generation ?? 0);
        setDirty(false);
      })
      .catch(() => setLoadError(t("theme_load_failed")));
  }, []);

  useEffect(reload, [reload]);

  const reloadInstalled = useCallback(() => {
    apiGet<{ themes: InstalledThemeWire[] }>("/themes/installed")
      .then((result) => setInstalled(result.themes))
      .catch(() => setInstalled(null));
  }, []);
  useEffect(reloadInstalled, [reloadInstalled]);

  const installThemeFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (file === undefined) return;
    setInstallBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      await apiRequest("POST", "/themes/install", {
        headers: { "content-type": "application/octet-stream" },
        rawBody: bytes,
      });
      toast(t("theme_install_done"), "success");
      reloadInstalled();
    } catch {
      toast(t("theme_install_failed"), "error");
    } finally {
      setInstallBusy(false);
    }
  };

  const uninstallTheme = async (id: string) => {
    setInstallBusy(true);
    try {
      await apiDelete(`/themes/installed/${encodeURIComponent(id)}`);
      toast(t("theme_uninstall_done"), "success");
      reloadInstalled();
    } catch {
      toast(t("theme_uninstall_failed"), "error");
    } finally {
      setInstallBusy(false);
    }
  };

  if (loadError !== null) {
    return (
      <div>
        <p>{loadError}</p>
        <Button onClick={reload}>{t("retry")}</Button>
      </div>
    );
  }
  if (state === null) return <Spinner />;
  if (state.theme === null) {
    return (
      <EmptyState title={t("theme_not_configured_title")} hint={t("theme_not_configured_hint")} />
    );
  }

  const manifest = state.theme.manifest;

  const save = async () => {
    setBusy(true);
    try {
      const result = await apiPut<{ generation: number }>("/theme/settings", {
        values,
        expected_generation: generation,
      });
      setGeneration(result.generation);
      setDirty(false);
      toast(t("theme_save_done"), "success");
    } catch {
      toast(t("theme_save_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    setBusy(true);
    try {
      await apiPost("/theme/activate", { theme_key: manifest.id, theme_version: manifest.version });
      toast(t("theme_activate_done"), "success");
      reload();
    } catch {
      toast(t("theme_activate_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  /** Human publish flow (owner UX pass 0.1.28): save, seal the revision and
   * publish — the editor never sees the word "seal". */
  const publish = async () => {
    setBusy(true);
    try {
      if (dirty) {
        const saved = await apiPut<{ generation: number }>("/theme/settings", {
          values,
          expected_generation: generation,
        });
        setGeneration(saved.generation);
        setDirty(false);
      }
      const sealed = await apiPost<{ revision_id: string }>("/theme/settings/seal", {});
      await apiPost("/publications/publish", {
        entity_type: "theme_settings",
        entity_id: "0190c0de-0000-7000-8000-517e775e7760",
        target_revision_id: sealed.revision_id,
        expected_generation: publicationGeneration,
      });
      toast(t("theme_publish_done"), "success");
      reload();
    } catch {
      toast(t("theme_publish_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pcms-screen" data-testid="theme-screen">
      <div className="pcms-toolbar">
        <h1>{t("theme_title")}</h1>
        <span className="pcms-toolbar__spacer" />
        {state.active === null ? (
          <Badge tone="warning">{t("theme_no_active")}</Badge>
        ) : (
          <Badge tone="success">
            {t("theme_active_badge", {
              key: state.active.theme_key,
              version: state.active.theme_version,
            })}
          </Badge>
        )}
        {state.publication?.pending === true ? (
          <Badge tone="warning" data-testid="theme-publication-status">
            {t("theme_status_pending")}
          </Badge>
        ) : (
          <Badge tone="success" data-testid="theme-publication-status">
            {t("theme_status_published")}
          </Badge>
        )}
        {auth.can("theme.activate") ? (
          state.active === null || state.active.theme_key !== manifest.id ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void activate()}>
              {t("theme_activate_button", { name: manifest.name })}
            </Button>
          ) : null
        ) : null}
      </div>

      <ThemeHistoryCleanup />
      <div className="pcms-panel" data-testid="theme-installed">
        <h3>{t("theme_installed_title")}</h3>
        <p className="pcms-field__hint">{t("theme_installed_hint")}</p>
        {installed === null ? (
          <Spinner />
        ) : installed.length === 0 ? (
          <p className="pcms-text-muted">{t("theme_installed_empty")}</p>
        ) : (
          <div className="pcms-table-wrap">
            <table className="pcms-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>{t("theme_installed_col_name")}</th>
                  <th>{t("theme_installed_col_version")}</th>
                  <th>{t("theme_installed_col_status")}</th>
                  {auth.can("theme.write") ? <th>{t("theme_installed_col_actions")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {installed.map((theme) => (
                  <tr key={theme.id}>
                    <td>
                      {theme.name} <code>{theme.id}</code>
                    </td>
                    <td>{theme.version}</td>
                    <td>
                      {theme.active ? (
                        <Badge tone="success">{t("theme_installed_active")}</Badge>
                      ) : theme.is_render_target ? (
                        <Badge tone="info">{t("theme_installed_render")}</Badge>
                      ) : theme.broken !== null ? (
                        <Badge tone="warning">{t("theme_installed_broken")}</Badge>
                      ) : (
                        <Badge tone="neutral">{t("theme_installed_idle")}</Badge>
                      )}
                    </td>
                    {auth.can("theme.write") ? (
                      <td>
                        {theme.is_render_target ? null : (
                          <Tooltip content={t("theme_tooltip_uninstall")}>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={installBusy}
                              data-testid={`theme-uninstall-${theme.id}`}
                              onClick={() => void uninstallTheme(theme.id)}
                            >
                              {t("theme_uninstall_button")}
                            </Button>
                          </Tooltip>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {auth.can("theme.write") ? (
          <>
            <input
              ref={installInputRef}
              type="file"
              accept=".zip"
              className="pcms-visually-hidden"
              aria-label={t("theme_install_aria")}
              onChange={(event) => void installThemeFile(event.target.files)}
            />
            <Tooltip content={t("theme_tooltip_install")}>
              <Button
                size="sm"
                variant="ghost"
                disabled={installBusy}
                data-testid="theme-install-upload"
                onClick={() => installInputRef.current?.click()}
              >
                {installBusy ? t("theme_install_busy") : t("theme_install_button")}
              </Button>
            </Tooltip>
          </>
        ) : null}
      </div>

      <div className="pcms-columns pcms-columns--tree">
        <div>
          <div className="pcms-panel">
            <h3>{t("theme_settings_title")}</h3>
            <p className="pcms-field__hint">{t("theme_settings_hint")}</p>
            {state.manifest_settings.length === 0 ? (
              <p className="pcms-text-muted">{t("theme_settings_empty")}</p>
            ) : (
              <>
                {state.manifest_settings.map((setting) => (
                  <ThemeSettingControl
                    key={setting.key}
                    setting={setting}
                    value={values[setting.key]}
                    disabled={!auth.can("theme.write") || busy}
                    assetBase={`/themes/${manifest.id}`}
                    onChange={(value) => {
                      setValues((current) => ({ ...current, [setting.key]: value }));
                      setDirty(true);
                    }}
                  />
                ))}
                <div className="pcms-actions-row">
                  {auth.can("theme.write") ? (
                    <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
                      {t("theme_save_button")}
                    </Button>
                  ) : null}
                  {auth.can("theme.write") && auth.can("publication.publish") ? (
                    <Button disabled={busy} onClick={() => void publish()}>
                      {t("theme_publish_button")}
                    </Button>
                  ) : null}
                  <span data-testid="theme-dirty">{dirty ? t("save_dirty") : ""}</span>
                </div>
              </>
            )}
          </div>

          <div className="pcms-panel">
            <h3>{t("theme_validation_title")}</h3>
            <p>
              {t("theme_validation_state")}:{" "}
              {state.theme.validation?.ok === true ? (
                <Badge tone="success">{t("theme_validation_ok")}</Badge>
              ) : (
                <Badge tone="danger">{t("theme_validation_issues")}</Badge>
              )}
            </p>
            {state.theme.validation?.issues?.length ? (
              <ul>
                {state.theme.validation.issues.map((issue) => (
                  <li key={issue.message} className="pcms-field__error">
                    {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="pcms-field__hint">{t("theme_preview_hint")}</p>
          </div>
        </div>

        <div className="pcms-panel">
          <h3>{t("theme_dev_info_title")}</h3>
          <dl>
            <dt>{t("theme_dev_theme")}</dt>
            <dd>
              {t("theme_dev_version_line", {
                name: manifest.name,
                id: manifest.id,
                version: manifest.version,
              })}
            </dd>
            <dt>{t("theme_dev_contract")}</dt>
            <dd>{state.theme.theme_contract_version}</dd>
            <dt>{t("theme_dev_templates")}</dt>
            <dd>{state.theme.templates.map((template) => template.id).join(", ")}</dd>
            <dt>{t("theme_dev_placements")}</dt>
            <dd>
              {state.theme.navigation_placements
                .map((placement) => `${placement.id} (≤${placement.max_depth})`)
                .join(", ")}
            </dd>
            <dt>{t("theme_dev_presets")}</dt>
            <dd>{state.theme.media_presets.map((preset) => preset.id).join(", ") || "—"}</dd>
            <dt>{t("theme_dev_thememd")}</dt>
            <dd>{t("theme_dev_source_path", { id: manifest.id })}</dd>
          </dl>
          <p className="pcms-field__hint">{t("theme_dev_hint")}</p>
        </div>
      </div>
    </div>
  );
}

function defaultValues(settings: readonly ManifestSetting[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const setting of settings) {
    if (setting.default !== undefined) values[setting.key] = setting.default;
  }
  return values;
}

function ThemeSettingControl(props: {
  readonly setting: ManifestSetting;
  readonly value: unknown;
  readonly disabled?: boolean;
  /** Public base of the active theme's bundled assets ("assets/img/…" setting
   * values preview from here instead of a misleading missing state). */
  readonly assetBase?: string;
  readonly onChange: (value: unknown) => void;
}) {
  const setting = props.setting;
  const label = themeSettingLabel(setting);
  if (setting.type === "boolean") {
    return (
      <Field label={label} {...(setting.token === undefined ? {} : { hint: setting.token })}>
        <Switch
          checked={props.value === true}
          label={props.value === true ? t("theme_switch_on") : t("theme_switch_off")}
          onChange={props.onChange}
          {...(props.disabled === true ? { disabled: true } : {})}
        />
      </Field>
    );
  }
  if (setting.type === "enum" && setting.values !== undefined) {
    return (
      <Field label={label} {...(setting.token === undefined ? {} : { hint: setting.token })}>
        <Select
          value={typeof props.value === "string" ? props.value : ""}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
        >
          {setting.values.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (setting.type === "number") {
    return (
      <Field label={label} {...(setting.token === undefined ? {} : { hint: setting.token })}>
        <Input
          type="number"
          value={props.value === undefined || props.value === null ? "" : String(props.value)}
          disabled={props.disabled}
          onChange={(event) =>
            props.onChange(event.target.value === "" ? undefined : Number(event.target.value))
          }
        />
      </Field>
    );
  }
  if (setting.type === "media") {
    // Media-library values (hero slides, logo, collage photos) get the same
    // picker card as content editor image fields — a raw text input was the
    // pre-0.1.73 gap that made hero photos unmanageable from Admin.
    return (
      <Field label={label} {...(setting.token === undefined ? {} : { hint: setting.token })}>
        <MediaControl
          schema={{} as FieldSchemaWire}
          value={props.value}
          onChange={props.onChange}
          {...(props.assetBase === undefined ? {} : { assetBase: props.assetBase })}
          {...(props.disabled === true ? { disabled: true } : {})}
        />
      </Field>
    );
  }
  return (
    <Field label={label} {...(setting.token === undefined ? {} : { hint: setting.token })}>
      <Input
        value={typeof props.value === "string" ? props.value : ""}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
  );
}
