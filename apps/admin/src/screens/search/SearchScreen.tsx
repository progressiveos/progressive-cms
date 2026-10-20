// Admin search (owner UX pass 0.1.28): the search subsystem has been shipped
// since M11 — this screen surfaces it. One query over /search/admin returns
// published entries, draft titles, media and navigation labels; the secondary
// panel exposes index health for operators (search.diagnostics) without
// turning the screen into a diagnostics dashboard.
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, apiPost } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { useToast } from "../../design/toast.js";
import { Badge, Button, EmptyState, Field, Icon, Input, Spinner } from "../../design/ui.js";
import { formatDateTime } from "../../i18n/format.js";
import { errorText, t } from "../../i18n/index.js";
import { useRoute } from "../../layout/router.js";

type Scope = "all" | "published" | "drafts";

interface SnippetSegmentWire {
  readonly text: string;
  readonly match: boolean;
}

function SnippetSegments({ segments }: { segments: readonly SnippetSegmentWire[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static per-search render, never reordered
          <mark key={index}>{segment.text}</mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static per-search render, never reordered
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

interface PublishedHit {
  readonly entity_id: string;
  readonly content_type: string | null;
  readonly title: string;
  readonly path: string | null;
  readonly published_at: string | null;
  readonly snippet: readonly SnippetSegmentWire[] | null;
}

interface DraftHit {
  readonly entity_id: string;
  readonly content_type: string | null;
  readonly title: string | null;
  readonly updated_at: string;
}

interface MediaHit {
  readonly asset_id: string;
  readonly filename: string;
  readonly kind: string;
}

interface SearchResults {
  readonly query: string;
  readonly published: { readonly items: readonly PublishedHit[]; readonly total: number };
  readonly drafts: readonly DraftHit[];
  readonly media: readonly MediaHit[];
}

interface IndexHealth {
  readonly available: boolean;
  readonly reindex_required: boolean;
  readonly document_count: number;
  readonly building_epoch: number | null;
  readonly last_reindex_at: string | null;
  readonly last_error: string | null;
}

const SCOPES: readonly { readonly id: Scope; readonly labelKey: string }[] = [
  { id: "all", labelKey: "search.scope_all" },
  { id: "published", labelKey: "search.scope_published" },
  { id: "drafts", labelKey: "search.scope_drafts" },
];

export function SearchScreen() {
  const auth = useAuth();
  const toast = useToast();
  const route = useRoute();
  const [term, setTerm] = useState(route.query.get("q") ?? "");
  const [scope, setScope] = useState<Scope>("all");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async (query: string) => {
    if (query.trim() === "") {
      setResults(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await apiGet<SearchResults>(
        `/search/admin?q=${encodeURIComponent(query.trim())}&locale=default&limit=20`,
      );
      setResults(result);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("search.load_failed"),
      );
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Deep link (?q=) runs the search on arrival and when it changes; the
  // explicit submit drives it afterwards.
  const initialQuery = route.query.get("q") ?? "";
  useEffect(() => {
    if (initialQuery.trim() !== "") void runSearch(initialQuery);
  }, [initialQuery, runSearch]);

  const showPublished = scope === "all" || scope === "published";
  const showDrafts = scope === "all" || scope === "drafts";
  const hasResults =
    results !== null &&
    ((showPublished && results.published.items.length > 0) ||
      (showDrafts && results.drafts.length > 0) ||
      (scope === "all" && results.media.length > 0));

  return (
    <div className="pcms-screen--narrow" data-testid="search-screen">
      <h1>{t("search.title")}</h1>
      <form
        className="pcms-row"
        style={{ alignItems: "flex-end" }}
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(term);
        }}
      >
        <div style={{ flex: 1 }}>
          <Field label={t("search.query_label")}>
            <Input
              autoFocus
              type="search"
              value={term}
              placeholder={t("search.query_placeholder")}
              onChange={(event) => setTerm(event.target.value)}
            />
          </Field>
        </div>
        <Button variant="primary" disabled={loading} onClick={() => void runSearch(term)}>
          <Icon name="search" /> {t("search.run")}
        </Button>
      </form>

      {/* biome-ignore lint/a11y/useSemanticElements: flex toolbar row, not a form group */}
      <div className="pcms-row" role="group" aria-label={t("search.scope_label")}>
        {SCOPES.map((candidate) => (
          <Button
            key={candidate.id}
            size="sm"
            variant={scope === candidate.id ? "secondary" : "ghost"}
            aria-pressed={scope === candidate.id}
            onClick={() => setScope(candidate.id)}
          >
            {t(candidate.labelKey)}
          </Button>
        ))}
      </div>

      {loading ? <Spinner /> : null}
      {error !== null ? (
        <div className="pcms-field__error" role="alert">
          {error}
        </div>
      ) : null}

      {results !== null && !loading && results.query.trim() !== "" && !hasResults ? (
        <EmptyState title={t("search.empty_title")} hint={t("search.empty_hint")} />
      ) : null}

      {results !== null && !loading && showPublished && results.published.items.length > 0 ? (
        <section>
          <h3>
            {t("search.published_heading")} <Badge>{String(results.published.total)}</Badge>
          </h3>
          <ul className="pcms-search-results" data-testid="search-results-published">
            {results.published.items.map((hit) => (
              <li key={hit.entity_id}>
                <a className="pcms-search-hit" href={`#/content/${hit.entity_id}`}>
                  <span className="pcms-search-hit__title">{hit.title}</span>
                  <span className="pcms-picker-row__meta">
                    {hit.content_type ?? ""}
                    {hit.path === null ? "" : ` · ${hit.path}`}
                    {hit.published_at === null ? "" : ` · ${formatDateTime(hit.published_at)}`}
                  </span>
                  {hit.snippet !== null ? (
                    <span className="pcms-search-hit__snippet">
                      <SnippetSegments segments={hit.snippet} />
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {results !== null && !loading && showDrafts && results.drafts.length > 0 ? (
        <section>
          <h3>{t("search.drafts_heading")}</h3>
          <ul className="pcms-search-results" data-testid="search-results-drafts">
            {results.drafts.map((hit) => (
              <li key={hit.entity_id}>
                <a className="pcms-search-hit" href={`#/content/${hit.entity_id}`}>
                  <span className="pcms-search-hit__title">{hit.title ?? t("tree_untitled")}</span>
                  <span className="pcms-picker-row__meta">
                    {t("search.draft_badge")} · {hit.content_type ?? ""} ·{" "}
                    {formatDateTime(hit.updated_at)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {results !== null && !loading && scope === "all" && results.media.length > 0 ? (
        <section>
          <h3>{t("search.media_heading")}</h3>
          <ul className="pcms-search-results">
            {results.media.map((hit) => (
              <li key={hit.asset_id}>
                <a className="pcms-search-hit" href="#/media">
                  <span className="pcms-search-hit__title">{hit.filename}</span>
                  <span className="pcms-picker-row__meta">{hit.kind}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {auth.can("search.diagnostics") ? <SearchOpsPanel /> : null}
    </div>
  );
}

/** Secondary operations panel — hidden from editors without the scope. */
function SearchOpsPanel() {
  const auth = useAuth();
  const toast = useToast();
  const [health, setHealth] = useState<IndexHealth | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void apiGet<{ health: IndexHealth }>("/search/status").then(
      (result) => setHealth(result.health),
      () => setHealth(null),
    );
  }, []);

  useEffect(reload, [reload]);

  if (health === null) return null;

  const state = !health.available
    ? { tone: "danger" as const, label: t("search.state_degraded") }
    : health.building_epoch !== null || health.reindex_required
      ? { tone: "warning" as const, label: t("search.state_building") }
      : { tone: "success" as const, label: t("search.state_active") };

  const reindex = async () => {
    setBusy(true);
    try {
      await apiPost("/search/reindex", {});
      toast(t("search.reindex_started"), "success");
      reload();
    } catch (caught) {
      toast(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("search.reindex_failed"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pcms-panel" data-testid="search-ops">
      <h3>{t("search.ops_title")}</h3>
      <div className="pcms-row" style={{ alignItems: "center" }}>
        <Badge tone={state.tone}>{state.label}</Badge>
        <span className="pcms-picker-row__meta">
          {t("search.documents", { count: String(health.document_count) })}
          {health.last_reindex_at === null
            ? ""
            : ` · ${t("search.last_reindex", { time: formatDateTime(health.last_reindex_at) })}`}
        </span>
      </div>
      {auth.can("search.reindex") ? (
        <div className="pcms-actions-row">
          <Button size="sm" disabled={busy} onClick={() => void reindex()}>
            {t("search.reindex_button")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
