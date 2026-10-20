// SEO tab (PCMS-ADMIN-T010; Admin spec §26): explicit overrides are edited;
// deterministic fallbacks are shown WITH their provenance; semantic content
// fields, SEO overrides and social overrides stay clearly separated.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPut } from "../../../api/client.js";
import { Dialog } from "../../../design/dialog.js";
import { useToast } from "../../../design/toast.js";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Input,
  Select,
  Spinner,
  Textarea,
} from "../../../design/ui.js";
import { t } from "../../../i18n/index.js";
import { MediaPickerDialog } from "../fields/pickers.js";

interface SeoDocumentWire {
  readonly seo_title: string | null;
  readonly meta_description: string | null;
  readonly canonical_override: string | null;
  readonly robots_policy: { readonly index: boolean; readonly follow: boolean } | null;
  readonly social_title: string | null;
  readonly social_description: string | null;
  readonly social_image: { readonly asset_id: string } | null;
  readonly structured_data_type_hint: string | null;
}

interface ResolvedValue {
  readonly value: unknown;
  readonly source: string;
  readonly reason?: string;
}

interface ResolvedWire {
  readonly resolved: {
    readonly title: ResolvedValue;
    readonly description: ResolvedValue;
    readonly social_title: ResolvedValue;
    readonly social_description: ResolvedValue;
  };
  readonly canonical: string | null;
  readonly robots: string | null;
}

interface JsonLdDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning" | "recommendation";
  readonly message: string;
  readonly path?: string;
}

interface JsonLdWire {
  readonly structured_data: {
    readonly json_ld: readonly string[];
    readonly nodes: readonly unknown[];
    readonly diagnostics: readonly JsonLdDiagnostic[];
  } | null;
}

const SEVERITY_TONE: Record<JsonLdDiagnostic["severity"], "danger" | "warning" | "info"> = {
  error: "danger",
  warning: "warning",
  recommendation: "info",
};

/** JSON-LD diagnostics in-place (owner UX): the composed graph + findings are
 * shown in a dialog instead of sending the operator to a raw API URL. */
function JsonLdDialog(props: { readonly entryId: string; readonly onClose: () => void }) {
  const [data, setData] = useState<JsonLdWire["structured_data"] | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<JsonLdWire>(`/discovery/seo/structured-data?entry_id=${props.entryId}`)
      .then((result) => {
        if (!cancelled) setData(result.structured_data ?? null);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [props.entryId]);

  const diagnostics = data?.diagnostics ?? [];
  return (
    <Dialog open wide title={t("seo.jsonld_link")} onClose={props.onClose}>
      {failed ? (
        <EmptyState title={t("error_title")} />
      ) : data === undefined ? (
        <Spinner />
      ) : (
        <div className="pcms-jsonld__body" data-testid="jsonld-diagnostics">
          {diagnostics.length === 0 ? (
            <p>
              <Badge tone="success">
                <Icon name="check" />
              </Badge>{" "}
              {t("seo.jsonld_status_ok")}
            </p>
          ) : (
            <p>
              <Badge tone={diagnostics.some((d) => d.severity === "error") ? "danger" : "warning"}>
                {t("seo.jsonld_status_problems", { count: diagnostics.length })}
              </Badge>
            </p>
          )}
          <ul className="pcms-jsonld__findings">
            {diagnostics.map((diagnostic) => (
              <li key={diagnostic.code}>
                <Badge tone={SEVERITY_TONE[diagnostic.severity]}>{diagnostic.severity}</Badge>{" "}
                {diagnostic.message}
                {diagnostic.path === undefined ? null : (
                  <span className="pcms-picker-row__meta"> {diagnostic.path}</span>
                )}
              </li>
            ))}
          </ul>
          {data === null || data.json_ld.length === 0 ? (
            <p className="pcms-text-muted">{t("seo.jsonld_none")}</p>
          ) : (
            <>
              <h3>{t("seo.jsonld_output")}</h3>
              {data.json_ld.map((block) => (
                <pre key={block} className="pcms-jsonld__pre">
                  {block}
                </pre>
              ))}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

const EMPTY_DOCUMENT = {
  seo_title: null,
  meta_description: null,
  canonical_override: null,
  robots_policy: null,
  social_title: null,
  social_description: null,
  social_image: null,
  structured_data_type_hint: null,
};

function ProvenanceLine(props: {
  readonly label: string;
  readonly resolved: ResolvedValue | undefined;
  readonly fallback: string;
}) {
  if (props.resolved === undefined) return null;
  return (
    <p className="pcms-field__hint" data-testid={`provenance-${props.fallback}`}>
      {props.label}: {String(props.resolved.value ?? "—")}{" "}
      <em>({t("seo.provenance_source", { source: props.resolved.source })})</em>
    </p>
  );
}

export function SeoTab(props: { readonly entryId: string }) {
  const toast = useToast();
  const [document, setDocument] = useState<SeoDocumentWire | null>(null);
  const [resolved, setResolved] = useState<ResolvedWire | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickingImage, setPickingImage] = useState(false);
  const [ldOpen, setLdOpen] = useState(false);

  const reload = useCallback(() => {
    setLoadError(null);
    Promise.all([
      apiGet<{ document: SeoDocumentWire | null }>(`/entries/${props.entryId}/seo`),
      apiGet<ResolvedWire>(`/discovery/seo/metadata/${props.entryId}`).catch(() => null),
    ])
      .then(([stored, resolvedResult]) => {
        setDocument(stored.document ?? { ...EMPTY_DOCUMENT });
        setResolved(resolvedResult);
      })
      .catch(() => setLoadError(t("seo.load_failed")));
  }, [props.entryId]);

  useEffect(reload, [reload]);

  if (loadError !== null) {
    return (
      <div>
        <p>{loadError}</p>
        <Button onClick={reload}>{t("seo.retry")}</Button>
      </div>
    );
  }
  if (document === null) return <Spinner />;

  const set = (patch: Partial<SeoDocumentWire>) => setDocument({ ...document, ...patch });

  const save = async () => {
    setBusy(true);
    try {
      await apiPut(`/entries/${props.entryId}/seo`, { document });
      toast(t("seo.saved"), "success");
      reload();
    } catch {
      toast(t("seo.save_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const origin = window.location.origin;
  const title = resolved?.resolved.title.value ?? document.seo_title ?? t("seo.default_title");
  const description = resolved?.resolved.description.value ?? document.meta_description ?? "";
  const canonical = resolved?.canonical ?? document.canonical_override ?? `${origin}/…`;

  return (
    <div data-testid="seo-tab">
      <div className="pcms-columns pcms-columns--tree">
        <div>
          <h3>{t("seo.overrides_title")}</h3>
          <Field label={t("seo.title_label")} hint={t("seo.title_hint")}>
            <Input
              value={document.seo_title ?? ""}
              maxLength={200}
              onChange={(event) =>
                set({ seo_title: event.target.value === "" ? null : event.target.value })
              }
            />
          </Field>
          <Field label={t("seo.meta_description_label")}>
            <Textarea
              value={document.meta_description ?? ""}
              maxLength={400}
              onChange={(event) =>
                set({ meta_description: event.target.value === "" ? null : event.target.value })
              }
            />
          </Field>
          <Field label={t("seo.robots_label")}>
            <Select
              value={
                document.robots_policy === null
                  ? "default"
                  : document.robots_policy.index
                    ? "index,follow"
                    : "noindex"
              }
              onChange={(event) =>
                set({
                  robots_policy:
                    event.target.value === "default"
                      ? null
                      : event.target.value === "noindex"
                        ? { index: false, follow: true }
                        : { index: true, follow: true },
                })
              }
            >
              <option value="default">{t("seo.robots_default")}</option>
              <option value="index,follow">{t("seo.robots_index")}</option>
              <option value="noindex">{t("seo.robots_noindex")}</option>
            </Select>
          </Field>
          <Field label={t("seo.canonical_label")} hint={t("seo.canonical_hint")}>
            <Input
              value={document.canonical_override ?? ""}
              onChange={(event) =>
                set({ canonical_override: event.target.value === "" ? null : event.target.value })
              }
            />
          </Field>
          <h3>{t("seo.social_heading")}</h3>
          <Field label={t("seo.social_title_label")}>
            <Input
              value={document.social_title ?? ""}
              maxLength={200}
              onChange={(event) =>
                set({ social_title: event.target.value === "" ? null : event.target.value })
              }
            />
          </Field>
          <Field label={t("seo.social_description_label")}>
            <Textarea
              value={document.social_description ?? ""}
              maxLength={400}
              onChange={(event) =>
                set({ social_description: event.target.value === "" ? null : event.target.value })
              }
            />
          </Field>
          <Field label={t("seo.social_image_label")} hint={t("seo.social_image_hint")}>
            <div className="pcms-ref">
              <span className="pcms-picker-row__meta">
                {document.social_image === null
                  ? t("seo.image_none")
                  : document.social_image.asset_id}
              </span>
              <Button size="sm" onClick={() => setPickingImage(true)}>
                {t("seo.image_pick")}
              </Button>
              {document.social_image === null ? null : (
                <Button size="sm" variant="ghost" onClick={() => set({ social_image: null })}>
                  <Icon name="close" label={t("delete")} />
                </Button>
              )}
            </div>
          </Field>
          <Field label={t("seo.structured_label")}>
            <Select
              value={document.structured_data_type_hint ?? ""}
              onChange={(event) =>
                set({
                  structured_data_type_hint: event.target.value === "" ? null : event.target.value,
                })
              }
            >
              <option value="">{t("seo.structured_auto")}</option>
              <option value="web_page">{t("seo.type_web_page")}</option>
              <option value="article">{t("seo.type_article")}</option>
              <option value="news_article">{t("seo.type_news_article")}</option>
              <option value="blog_posting">{t("seo.type_blog_posting")}</option>
            </Select>
          </Field>
          <div className="pcms-actions-row">
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {t("seo.save_button")}
            </Button>
            {resolved !== null ? (
              <Button onClick={() => setLdOpen(true)}>{t("seo.jsonld_link")}</Button>
            ) : null}
          </div>
        </div>

        <div>
          <h3>{t("seo.serp_title")}</h3>
          <div className="pcms-panel" data-testid="search-preview">
            <div className="pcms-serp__title">{String(title)}</div>
            <div className="pcms-serp__url">{canonical}</div>
            <div className="pcms-serp__desc">{String(description)}</div>
          </div>
          {resolved === null ? null : (
            <div className="pcms-panel">
              <h3>{t("seo.provenance_title")}</h3>
              <ProvenanceLine
                label={t("seo.prov_label_title")}
                resolved={resolved.resolved.title}
                fallback="title"
              />
              <ProvenanceLine
                label={t("seo.prov_label_description")}
                resolved={resolved.resolved.description}
                fallback="description"
              />
              <ProvenanceLine
                label={t("seo.prov_label_social_title")}
                resolved={resolved.resolved.social_title}
                fallback="social-title"
              />
              <ProvenanceLine
                label={t("seo.prov_label_social_description")}
                resolved={resolved.resolved.social_description}
                fallback="social-description"
              />
            </div>
          )}
        </div>
      </div>
      {pickingImage ? (
        <MediaPickerDialog
          open
          onClose={() => setPickingImage(false)}
          title={t("seo.social_image_label")}
          onPick={(mediaId) => set({ social_image: { asset_id: mediaId } })}
        />
      ) : null}
      {ldOpen ? <JsonLdDialog entryId={props.entryId} onClose={() => setLdOpen(false)} /> : null}
    </div>
  );
}
