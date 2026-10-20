// Media acquisition UI (ADR-0013, Admin spec §70): provider-neutral Stock
// and Generate panels shared by the Media workspace and the content media
// picker. Capability-driven — the panels render only when an enabled
// provider exists; credentials never appear here (configuration lives in
// /admin/#/extensions). All provider interaction is server-side.
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../../api/client.js";
import { Button, EmptyState, Icon, Input, Select, Spinner } from "../../design/ui.js";
import { t } from "../../i18n/index.js";
import { loadMediaMeta } from "../content/fields/pickers.js";
import { useCapabilityOperation } from "./capability-binding.js";

export interface MediaProviderWire {
  readonly provider_id: string;
  readonly extension_id: string;
  readonly kind: "stock" | "generation";
  readonly display_name: string;
  readonly configured: boolean;
}

let providersCache: { at: number; items: readonly MediaProviderWire[] } | null = null;

/** Capability discovery (30s cache mirrors the server's registry cache). */
export function useMediaProviders(): {
  readonly providers: readonly MediaProviderWire[] | null;
  readonly reload: () => void;
} {
  const [providers, setProviders] = useState<readonly MediaProviderWire[] | null>(
    providersCache === null ? null : providersCache.items,
  );
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: module-level cache; tick forces refetch
  useEffect(() => {
    let cancelled = false;
    if (providersCache !== null && Date.now() - providersCache.at < 30_000) {
      setProviders(providersCache.items);
      return;
    }
    apiGet<{ items: readonly MediaProviderWire[] }>("/media/providers")
      .then((result) => {
        providersCache = { at: Date.now(), items: result.items };
        if (!cancelled) setProviders(result.items);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return {
    providers,
    reload: () => {
      providersCache = null;
      setTick((value) => value + 1);
    },
  };
}

/** Human, typed failure text — never a raw provider payload. */
export function acquisitionErrorText(code: string): string {
  const keyed: Record<string, string> = {
    PROVIDER_NOT_CONFIGURED: "media.acq_err_not_configured",
    PROVIDER_UNAUTHORIZED: "media.acq_err_unauthorized",
    PROVIDER_RATE_LIMITED: "media.acq_err_rate_limited",
    PROVIDER_TIMEOUT: "media.acq_err_timeout",
    PROVIDER_UNAVAILABLE: "media.acq_err_unavailable",
    MEDIA_CANDIDATE_EXPIRED: "media.acq_err_expired",
    MEDIA_CANDIDATE_INVALID: "media.acq_err_invalid",
    MEDIA_GENERATION_NOT_READY: "media.acq_err_not_ready",
    MEDIA_ACQUISITION_NOT_CONFIGURED: "media.acq_err_not_configured",
  };
  const key = keyed[code];
  return t(key === undefined ? "media.acq_err_generic" : key);
}

function errorText(cause: unknown): string {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as Record<string, unknown>).code)
      : cause instanceof Error
        ? cause.message
        : String(cause);
  return acquisitionErrorText(code);
}

interface StockCandidateWire {
  readonly candidate_ref: string;
  readonly provider_id: string;
  readonly provider_asset_id: string;
  readonly preview_url: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly creator_name: string | null;
}

interface StockSearchWire {
  readonly items: readonly StockCandidateWire[];
  readonly errors?: readonly { provider_id: string; code: string }[];
  readonly next_cursor: string | null;
}

export function StockPanel(props: {
  readonly onImported: (mediaId: string, label: string) => void;
}) {
  const { providers, reload: reloadProviders } = useMediaProviders();
  const stock = (providers ?? []).filter((entry) => entry.kind === "stock");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [orientation, setOrientation] = useState("");
  const [items, setItems] = useState<readonly StockCandidateWire[] | null>(null);
  const [errors, setErrors] = useState<readonly { provider_id: string; code: string }[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const lastQuery = useRef<{ query: string; provider: string; orientation: string } | null>(null);

  const configured = stock.filter((entry) => entry.configured);

  const runSearch = useCallback(
    (nextCursor: string | null) => {
      if (lastQuery.current === null) return;
      setLoading(true);
      setMessage(null);
      apiPost<StockSearchWire>("/media/stock/search", {
        query: lastQuery.current.query,
        ...(lastQuery.current.provider === "all"
          ? {}
          : { provider_id: lastQuery.current.provider }),
        ...(lastQuery.current.orientation === ""
          ? {}
          : { orientation: lastQuery.current.orientation }),
        ...(nextCursor === null ? {} : { cursor: nextCursor }),
      })
        .then((result) => {
          setErrors(result.errors ?? []);
          setCursor(result.next_cursor);
          setItems(nextCursor === null ? result.items : [...(items ?? []), ...result.items]);
        })
        .catch((cause: unknown) => setMessage(errorText(cause)))
        .finally(() => setLoading(false));
    },
    [items],
  );

  if (stock.length === 0) return null;
  if (!stock.some((entry) => entry.configured)) {
    return (
      <EmptyState
        title={t("media.acq_not_configured_title")}
        hint={t("media.acq_not_configured_hint")}
      />
    );
  }

  return (
    <div data-testid="media-stock-panel">
      <div className="pcms-mediapicker__toolbar">
        <Input
          placeholder={t("media.acq_query")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("media.acq_query")}
          onKeyDown={(event) => {
            if (event.key === "Enter" && query.trim() !== "") {
              lastQuery.current = { query, provider, orientation };
              setCursor(null);
              setItems(null);
              runSearch(null);
            }
          }}
        />
        <Select
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          aria-label={t("media.acq_provider")}
        >
          <option value="all">{t("media.acq_provider_all")}</option>
          {configured.map((entry) => (
            <option key={entry.provider_id} value={entry.provider_id}>
              {entry.display_name}
            </option>
          ))}
        </Select>
        <Select
          value={orientation}
          onChange={(event) => setOrientation(event.target.value)}
          aria-label={t("media.acq_orientation")}
        >
          <option value="">{t("media.acq_orientation_any")}</option>
          <option value="landscape">{t("media.acq_orientation_landscape")}</option>
          <option value="portrait">{t("media.acq_orientation_portrait")}</option>
          <option value="square">{t("media.acq_orientation_square")}</option>
        </Select>
        <Button
          variant="primary"
          disabled={query.trim() === "" || loading}
          onClick={() => {
            lastQuery.current = { query, provider, orientation };
            setCursor(null);
            setItems(null);
            runSearch(null);
          }}
        >
          <Icon name="search" /> {t("media.acq_search")}
        </Button>
      </div>
      {errors.length > 0 ? (
        <p className="pcms-field__hint">{t("media.acq_provider_partial")}</p>
      ) : null}
      {message !== null ? (
        <p className="pcms-field__error" role="alert">
          {message}
        </p>
      ) : null}
      {items === null && loading ? <Spinner /> : null}
      {items !== null && items.length === 0 && !loading ? (
        <EmptyState title={t("media.acq_stock_empty")} hint={t("media.acq_query")} />
      ) : null}
      {items !== null && items.length > 0 ? (
        <div className="pcms-mediagrid">
          {items.map((candidate) => (
            <div key={candidate.candidate_ref} className="pcms-mediagrid__card">
              <span className="pcms-mediagrid__thumb">
                {candidate.preview_url === null ? null : (
                  <img src={candidate.preview_url} alt="" loading="lazy" />
                )}
              </span>
              <span className="pcms-mediagrid__name">
                {candidate.creator_name ?? candidate.provider_id}
              </span>
              <span className="pcms-mediagrid__meta">
                {candidate.width !== null && candidate.height !== null
                  ? `${candidate.width}×${candidate.height} · ${candidate.provider_id}`
                  : candidate.provider_id}
              </span>
              <Button
                size="sm"
                disabled={busyRef !== null}
                onClick={() => {
                  setBusyRef(candidate.candidate_ref);
                  setMessage(null);
                  apiPost<{ media_id: string; duplicate: boolean }>("/media/stock/import", {
                    candidate_ref: candidate.candidate_ref,
                  })
                    .then(async (result) => {
                      const meta = await loadMediaMeta(result.media_id).catch(() => null);
                      props.onImported(
                        result.media_id,
                        meta?.title ?? meta?.filenameOriginal ?? result.media_id,
                      );
                      setMessage(t("media.acq_imported"));
                      reloadProviders();
                    })
                    .catch((cause: unknown) => setMessage(errorText(cause)))
                    .finally(() => setBusyRef(null));
                }}
              >
                {busyRef === candidate.candidate_ref
                  ? t("media.acq_importing")
                  : t("media.acq_import")}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {cursor !== null && items !== null && items.length > 0 ? (
        <Button disabled={loading} onClick={() => runSearch(cursor)}>
          {t("media.acq_more")}
        </Button>
      ) : null}
    </div>
  );
}

interface GenerationCandidateWire {
  readonly index: number;
  readonly preview_url: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly media_id?: string;
}

interface GenerationRunWire {
  readonly generation_id: string;
  readonly status: string;
  readonly candidates: readonly GenerationCandidateWire[];
  readonly error?: { readonly code: string; readonly message: string | null };
}

export function GeneratePanel(props: {
  readonly onAccepted: (mediaId: string, label: string) => void;
}) {
  const { providers } = useMediaProviders();
  const generators = (providers ?? []).filter((entry) => entry.kind === "generation");
  const [provider, setProvider] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [aspect, setAspect] = useState("16:9");
  // Default = 1 image (owner decision, PCMS-PRE-RESEARCH A3).
  const [count, setCount] = useState(1);
  const [run, setRun] = useState<GenerationRunWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Prompt enhancement (PCMS-PRE-RESEARCH A4): offered only when some enabled
  // extension contributes an operation with the media.prompt-enhance
  // capability (capability binding, ADR-0017 S4 — no extension ids here).
  // The improved text is a PREVIEW — applied only after the operator confirms,
  // revert restores the original.
  const enhanceBinding = useCapabilityOperation("media.prompt-enhance");
  const enhanceAvailable = enhanceBinding !== null;
  const [enhancing, setEnhancing] = useState(false);
  const [enhanced, setEnhanced] = useState<string | null>(null);
  const promptBeforeEnhance = useRef<string>("");

  const configured = generators.filter((entry) => entry.configured);
  const selectedProvider =
    configured.find((entry) => entry.provider_id === provider) ?? configured[0];

  const enhance = () => {
    if (prompt.trim() === "" || enhanceBinding === null) return;
    setEnhancing(true);
    setMessage(null);
    promptBeforeEnhance.current = prompt;
    apiPost<{ prompt: string }>(
      `/extensions/${encodeURIComponent(enhanceBinding.extensionId)}/operations/${encodeURIComponent(enhanceBinding.operationId)}`,
      {
        prompt,
      },
    )
      .then((result) => setEnhanced(result.prompt))
      .catch((cause: unknown) => setMessage(errorText(cause)))
      .finally(() => setEnhancing(false));
  };

  useEffect(() => {
    if (run === null || (run.status !== "pending" && run.status !== "running")) return;
    pollRef.current = setInterval(() => {
      apiGet<GenerationRunWire>(`/media/generations/${run.generation_id}`)
        .then((result) => {
          setRun(result);
          if (result.status === "ready" || result.status === "failed") {
            if (pollRef.current !== null) clearInterval(pollRef.current);
            if (result.status === "failed") {
              setMessage(
                result.error === undefined
                  ? t("media.acq_err_generic")
                  : acquisitionErrorText(result.error.code),
              );
            }
          }
        })
        .catch(() => {});
    }, 2000);
    return () => {
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, [run]);

  if (generators.length === 0) return null;
  if (configured.length === 0) {
    return (
      <EmptyState
        title={t("media.acq_not_configured_title")}
        hint={t("media.acq_not_configured_hint")}
      />
    );
  }

  const start = () => {
    if (selectedProvider === undefined || prompt.trim() === "") return;
    setBusy(true);
    setMessage(null);
    setRun(null);
    apiPost<GenerationRunWire>("/media/generations", {
      prompt,
      provider_id: selectedProvider.provider_id,
      aspect,
      count,
      ...(negative === "" ? {} : { negative_prompt: negative }),
    })
      .then((created) => {
        setRun({ ...created, candidates: [] });
      })
      .catch((cause: unknown) => setMessage(errorText(cause)))
      .finally(() => setBusy(false));
  };

  const accept = (index: number) => {
    if (run === null) return;
    setBusy(true);
    setMessage(null);
    apiPost<{ media_id: string; duplicate: boolean }>(
      `/media/generations/${run.generation_id}/candidates/${index}/accept`,
      {},
    )
      .then(async (result) => {
        const meta = await loadMediaMeta(result.media_id).catch(() => null);
        props.onAccepted(result.media_id, meta?.title ?? meta?.filenameOriginal ?? result.media_id);
        setMessage(t("media.acq_accepted"));
      })
      .catch((cause: unknown) => setMessage(errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid="media-generate-panel">
      <div className="pcms-mediapicker__toolbar">
        <Input
          placeholder={t("media.acq_prompt")}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          aria-label={t("media.acq_prompt")}
        />
        {enhanceAvailable ? (
          <Button disabled={enhancing || busy || prompt.trim() === ""} onClick={enhance}>
            {enhancing ? t("media.acq_enhancing") : t("media.acq_enhance")}
          </Button>
        ) : null}
        <Input
          placeholder={t("media.acq_negative")}
          value={negative}
          onChange={(event) => setNegative(event.target.value)}
          aria-label={t("media.acq_negative")}
        />
        <Select
          value={aspect}
          onChange={(event) => setAspect(event.target.value)}
          aria-label={t("media.acq_aspect")}
        >
          {["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select
          value={String(count)}
          onChange={(event) => setCount(Number(event.target.value))}
          aria-label={t("media.acq_count")}
        >
          {[1, 2, 3, 4].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Button variant="primary" disabled={busy || prompt.trim() === ""} onClick={start}>
          {t("media.acq_generate")}
        </Button>
      </div>
      {enhanced !== null ? (
        <div data-testid="prompt-enhance-preview">
          <p className="pcms-field__hint">{t("media.acq_enhance_preview")}</p>
          <textarea
            className="pcms-input"
            rows={3}
            value={enhanced}
            onChange={(event) => setEnhanced(event.target.value)}
          />
          <p>
            <Button
              variant="primary"
              onClick={() => {
                setPrompt(enhanced);
                setEnhanced(null);
              }}
            >
              {t("media.acq_enhance_use")}
            </Button>{" "}
            <Button
              variant="ghost"
              onClick={() => {
                setPrompt(promptBeforeEnhance.current);
                setEnhanced(null);
              }}
            >
              {t("media.acq_enhance_revert")}
            </Button>
          </p>
        </div>
      ) : null}
      {configured.length > 1 ? (
        <Select
          value={selectedProvider?.provider_id ?? ""}
          onChange={(event) => setProvider(event.target.value)}
          aria-label={t("media.acq_provider")}
        >
          {configured.map((entry) => (
            <option key={entry.provider_id} value={entry.provider_id}>
              {entry.display_name}
            </option>
          ))}
        </Select>
      ) : null}
      {message !== null ? (
        <p className="pcms-field__error" role="alert">
          {message}
        </p>
      ) : null}
      {run !== null && (run.status === "pending" || run.status === "running") ? <Spinner /> : null}
      {run !== null && run.status === "ready" ? (
        <div className="pcms-mediagrid">
          {run.candidates.map((candidate) => (
            <div key={candidate.index} className="pcms-mediagrid__card">
              <span className="pcms-mediagrid__thumb">
                {candidate.preview_url === null ? null : (
                  <img src={candidate.preview_url} alt="" loading="lazy" />
                )}
              </span>
              {candidate.media_id !== undefined ? (
                <span className="pcms-mediagrid__meta">{t("media.acq_accepted")}</span>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => accept(candidate.index)}>
                  {t("media.acq_accept")}
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
