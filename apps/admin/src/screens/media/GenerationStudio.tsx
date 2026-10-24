// Generation Studio (Image Generation v2, plan F4/T4.1): Art-Studio-style
// generation screen over the v2 model contracts — configured-model selector,
// resolution-tier chips + ratio cards from the model's size options, prompt
// with bilingual AI Enhance, seed, count ladder (default 1; "2" tucked under
// "advanced", grid ready for 4), live cost estimate, results from the
// worker's auto-import (media_id thumbnails), history = library filtered to
// origin=generated with one-click prompt/params restore for regeneration.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "../../api/client.js";
import { Dialog } from "../../design/dialog.js";
import { Button, EmptyState, Field, Input, Select, Spinner } from "../../design/ui.js";
import { t } from "../../i18n/index.js";
import { useCapabilityOperation } from "./capability-binding.js";
import { type MediaVariantFailureWire, mediaVariantWarning } from "./variant-warning.js";

interface SizeOptionWire {
  readonly ratio: string;
  readonly width: number;
  readonly height: number;
  readonly tier: string | null;
}

interface ModelWire {
  readonly model: string;
  readonly display_name: string;
  readonly provider_id: string;
  readonly size_options: readonly SizeOptionWire[];
  readonly dimension_mode: "widthHeight" | "resolutionOrWidthHeight";
  readonly resolution_map: Readonly<Record<string, string>> | null;
  readonly supports_negative_prompt: boolean;
  readonly max_reference_images: number;
  readonly max_count: number;
  readonly stale: boolean;
}

interface CapabilitiesWire {
  readonly provider_id: string;
  readonly configured_models: readonly Omit<ModelWire, "provider_id">[];
}

interface EstimateWire {
  readonly estimate: {
    readonly per_image_usd: number | null;
    readonly total_usd: number | null;
    readonly approximate: boolean;
    readonly basis: string;
    readonly hint: string | null;
  };
}

interface CandidateWire {
  readonly index: number;
  readonly preview_url: string | null;
  readonly media_id?: string;
  readonly media_variant_failures?: readonly MediaVariantFailureWire[];
  readonly width: number | null;
  readonly height: number | null;
  readonly seed: number | null;
  readonly cost: number | null;
}

interface RunWire {
  readonly generation_id: string;
  readonly status: "pending" | "running" | "ready" | "failed";
  readonly error?: { readonly code: string; readonly message: string };
  readonly cost: number | null;
  readonly candidates: readonly CandidateWire[];
}

interface HistoryItem {
  readonly id: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly provider_id?: string | null;
  readonly provenance?: {
    readonly model?: string | null;
    readonly prompt?: string | null;
    readonly seed?: number | null;
    readonly settings?: { readonly resolution?: string | null; readonly aspect?: string | null };
  } | null;
}

const TIERS = ["0.5k", "1k", "2k", "4k"] as const;

function formatUsd(value: number): string {
  return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

export function GenerationStudio(props: {
  readonly onUsed: (mediaId: string, failures?: readonly MediaVariantFailureWire[]) => void;
}) {
  const [models, setModels] = useState<readonly ModelWire[] | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [tier, setTier] = useState<string>("1k");
  const [ratio, setRatio] = useState<string>("1:1");
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [seed, setSeed] = useState("");
  const [count, setCount] = useState(1);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [references, setReferences] = useState<readonly string[]>([]);
  const [picking, setPicking] = useState(false);
  const [run, setRun] = useState<RunWire | null>(null);
  const [estimate, setEstimate] = useState<EstimateWire["estimate"] | null>(null);
  const [enhanced, setEnhanced] = useState<{ en: string; ru: string | null } | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly HistoryItem[] | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const estimateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = useMemo(
    () => models?.find((entry) => entry.model === selectedModel) ?? models?.[0] ?? null,
    [models, selectedModel],
  );

  const tiersForModel = useMemo(() => {
    if (active === null) return [];
    const available = new Set(active.size_options.map((option) => option.tier));
    return TIERS.filter((entry) => available.has(entry));
  }, [active]);

  const sizesForModel = useMemo(() => {
    if (active === null) return [];
    const matching = active.size_options.filter(
      (option) => option.tier === tier && option.ratio === ratio,
    );
    return matching.length > 0
      ? matching
      : active.size_options.filter((option) => option.tier === tier);
  }, [active, tier, ratio]);

  const loadModels = useCallback(async () => {
    const list =
      await apiGet<readonly { provider_id: string; kind: string; configured: boolean }[]>(
        "/media/providers",
      );
    const generators = list.filter((entry) => entry.kind === "generation" && entry.configured);
    const pages = await Promise.all(
      generators.map((entry) =>
        apiGet<CapabilitiesWire>(`/media/providers/${entry.provider_id}/capabilities`).catch(
          () => null,
        ),
      ),
    );
    const flat: ModelWire[] = [];
    for (const page of pages) {
      if (page === null) continue;
      for (const model of page.configured_models) {
        flat.push({ ...model, provider_id: page.provider_id });
      }
    }
    setModels(flat);
  }, []);

  const loadHistory = useCallback(async () => {
    const page = await apiGet<{ items: readonly HistoryItem[] }>(
      "/media?origin=generated&limit=24",
    ).catch(() => null);
    setHistory(page?.items ?? []);
  }, []);

  useEffect(() => {
    void loadModels();
    void loadHistory();
  }, [loadModels, loadHistory]);

  // Drop excess references when the model allows fewer than selected.
  useEffect(() => {
    const cap = active?.max_reference_images ?? 0;
    if (cap > 0 && references.length > cap) {
      setReferences(references.slice(0, cap));
    }
  }, [active, references]);

  // Model defaults: first available tier/ratio whenever the model changes.
  useEffect(() => {
    if (active === null) return;
    const available = new Set(active.size_options.map((option) => option.tier));
    if (!available.has(tier)) {
      const first = TIERS.find((entry) => available.has(entry));
      if (first !== undefined) setTier(first);
    }
  }, [active, tier]);

  useEffect(() => {
    if (sizesForModel.length === 0) return;
    if (!sizesForModel.some((option) => option.ratio === ratio)) {
      setRatio(sizesForModel[0]?.ratio ?? "1:1");
    }
  }, [sizesForModel, ratio]);

  // Live cost estimate (plan T4.4): debounced, only with a valid selection.
  useEffect(() => {
    if (active === null || sizesForModel.length === 0) {
      setEstimate(null);
      return;
    }
    if (estimateTimer.current !== null) clearTimeout(estimateTimer.current);
    estimateTimer.current = setTimeout(() => {
      apiPost<EstimateWire>("/media/generations/estimate", {
        provider_id: active.provider_id,
        model: active.model,
        aspect: ratio,
        resolution: tier,
        count,
      })
        .then((result) => setEstimate(result.estimate))
        .catch(() => setEstimate(null));
    }, 300);
    return () => {
      if (estimateTimer.current !== null) clearTimeout(estimateTimer.current);
    };
  }, [active, ratio, tier, count, sizesForModel.length]);

  // Run polling.
  useEffect(() => {
    if (run === null || (run.status !== "pending" && run.status !== "running")) return;
    pollRef.current = setInterval(() => {
      apiGet<RunWire>(`/media/generations/${run.generation_id}`)
        .then((result) => {
          setRun(result);
          if (result.status === "ready" || result.status === "failed") {
            if (pollRef.current !== null) clearInterval(pollRef.current);
            if (result.status === "ready") void loadHistory();
            if (result.status === "failed") setMessage(result.error?.message ?? null);
          }
        })
        .catch(() => {});
    }, 2000);
    return () => {
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, [run, loadHistory]);

  // Capability binding (ADR-0017 S4) — no extension ids in Core UI.
  const enhanceBinding = useCapabilityOperation("media.prompt-enhance");
  const enhance = () => {
    if (prompt.trim() === "" || enhanceBinding === null) return;
    setEnhancing(true);
    setEnhanced(null);
    apiPost<{ prompt: string; prompt_ru: string | null }>(
      `/extensions/${encodeURIComponent(enhanceBinding.extensionId)}/operations/${encodeURIComponent(enhanceBinding.operationId)}`,
      { prompt },
    )
      .then((result) => {
        setPrompt(result.prompt);
        setEnhanced({ en: result.prompt, ru: result.prompt_ru });
      })
      .catch((cause: unknown) =>
        setMessage(cause instanceof Error ? cause.message : t("media.studio_error_generic")),
      )
      .finally(() => setEnhancing(false));
  };

  const generate = () => {
    if (active === null || prompt.trim() === "") return;
    setBusy(true);
    setMessage(null);
    setRun(null);
    apiPost<RunWire>("/media/generations", {
      prompt,
      provider_id: active.provider_id,
      model: active.model,
      aspect: ratio,
      resolution: tier,
      count,
      ...(negative === "" || !active.supports_negative_prompt ? {} : { negative_prompt: negative }),
      ...(seed.trim() === "" ? {} : { seed: Number(seed) }),
      ...(references.length === 0 ? {} : { reference_media_ids: references }),
    })
      .then((created) => setRun({ ...created, candidates: [] }))
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : null))
      .finally(() => setBusy(false));
  };

  if (models === null) return <Spinner />;
  if (models.length === 0) {
    return (
      <EmptyState
        title={t("media.studio_no_models_title")}
        hint={t("media.studio_no_models_hint")}
      />
    );
  }

  const canGenerate = prompt.trim() !== "" && !busy && active !== null;

  return (
    <div className="pcms-studio" data-testid="generation-studio">
      <div className="pcms-studio__sidebar">
        <Field label={t("media.studio_model")}>
          <Select
            value={active?.model ?? ""}
            onChange={(event) => setSelectedModel(event.target.value)}
            aria-label={t("media.studio_model")}
          >
            {models.map((model) => (
              <option key={model.model} value={model.model}>
                {model.display_name}
                {model.stale ? ` (${t("media.studio_stale")})` : ""}
              </option>
            ))}
          </Select>
        </Field>

        {tiersForModel.length > 1 ? (
          <Field label={t("media.studio_resolution")}>
            <div className="pcms-studio__chips">
              {tiersForModel.map((entry) => (
                <Button
                  key={entry}
                  size="sm"
                  variant={tier === entry ? "primary" : "ghost"}
                  onClick={() => setTier(entry)}
                >
                  {entry.toUpperCase()}
                </Button>
              ))}
            </div>
          </Field>
        ) : null}

        <Field label={t("media.studio_format")}>
          <div className="pcms-studio__sizes">
            {sizesForModel.map((option) => (
              <Button
                key={`${option.ratio}:${option.width}x${option.height}`}
                size="sm"
                variant={option.ratio === ratio ? "primary" : "ghost"}
                onClick={() => setRatio(option.ratio)}
              >
                {option.ratio} · {option.width}×{option.height}
              </Button>
            ))}
          </div>
        </Field>

        <Field label={t("media.acq_prompt")}>
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={enhancing || enhanceBinding === null || prompt.trim() === ""}
              onClick={enhance}
            >
              {enhancing ? t("media.acq_enhancing") : t("media.acq_enhance")}
            </Button>
          </div>
          <textarea
            className="pcms-input"
            rows={5}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            aria-label={t("media.acq_prompt")}
          />
          {enhanced?.ru ? <p className="pcms-field__hint">{enhanced.ru}</p> : null}
        </Field>

        {active?.supports_negative_prompt ? (
          <Field label={t("media.acq_negative")}>
            <Input
              value={negative}
              onChange={(event) => setNegative(event.target.value)}
              aria-label={t("media.acq_negative")}
            />
          </Field>
        ) : null}

        {(active?.max_reference_images ?? 0) > 0 ? (
          <Field label={t("media.studio_references")} optional>
            <div className="pcms-studio__refs">
              {references.map((mediaId) => (
                <button
                  key={mediaId}
                  type="button"
                  className="pcms-studio__ref"
                  title={t("media.studio_reference_remove")}
                  onClick={() => setReferences(references.filter((entry) => entry !== mediaId))}
                >
                  <img
                    src={`/api/v1/media/${mediaId}/file?preview=thumbnail`}
                    alt=""
                    loading="lazy"
                  />
                </button>
              ))}
              {references.length < (active?.max_reference_images ?? 0) ? (
                <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>
                  {t("media.studio_reference_add")}
                </Button>
              ) : null}
            </div>
          </Field>
        ) : null}

        <Field label={t("media.studio_seed")}>
          <Input
            type="number"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
            placeholder={t("media.studio_seed_random")}
            aria-label={t("media.studio_seed")}
          />
        </Field>

        {/* Count ladder (owner decision 2026-09-28): 1 by default; the "2"
            option stays tucked away; the grid already renders 4. */}
        <div>
          <Button size="sm" variant="ghost" onClick={() => setAdvancedOpen(!advancedOpen)}>
            {t("media.studio_advanced")}
          </Button>
          {advancedOpen ? (
            <Field label={t("media.acq_count")}>
              <Select
                value={String(count)}
                onChange={(event) => setCount(Number(event.target.value))}
                aria-label={t("media.acq_count")}
              >
                <option value="1">{t("media.studio_count_one")}</option>
                <option value="2">{t("media.studio_count_two")}</option>
              </Select>
            </Field>
          ) : null}
        </div>

        <Button variant="primary" disabled={!canGenerate} onClick={generate}>
          {busy ? t("media.studio_generating") : t("media.acq_generate")}
        </Button>
        {estimate !== null ? (
          <p className="pcms-field__hint" data-testid="studio-estimate">
            {estimate.total_usd !== null
              ? `${estimate.approximate ? "≈ " : ""}${formatUsd(estimate.total_usd)} (${estimate.basis})`
              : (estimate.hint ?? null)}
          </p>
        ) : null}
        {message !== null ? (
          <p className="pcms-field__error" role="alert">
            {message}
          </p>
        ) : null}
        {picking ? (
          <ReferencePickerDialog
            onPick={(mediaId) => {
              setReferences((current) =>
                current.includes(mediaId) ? current : [...current, mediaId],
              );
            }}
            onClose={() => setPicking(false)}
          />
        ) : null}
      </div>

      <div className="pcms-studio__preview">
        {run !== null && (run.status === "pending" || run.status === "running") ? (
          <Spinner />
        ) : null}
        {run?.status === "ready" ? (
          <>
            {run.cost !== null ? (
              <p className="pcms-field__hint">
                {t("media.studio_actual_cost")}: {formatUsd(run.cost)}
              </p>
            ) : null}
            <div className="pcms-mediagrid">
              {run.candidates.map((candidate) => (
                <div key={candidate.index} className="pcms-mediagrid__card">
                  <span className="pcms-mediagrid__thumb">
                    <img
                      src={
                        candidate.media_id !== undefined
                          ? `/api/v1/media/${candidate.media_id}/file?preview=thumbnail`
                          : (candidate.preview_url ?? "")
                      }
                      alt=""
                      loading="lazy"
                    />
                  </span>
                  {candidate.media_id !== undefined ? (
                    <>
                      {candidate.media_variant_failures !== undefined ? (
                        <span className="pcms-field__error" role="alert">
                          {mediaVariantWarning(candidate.media_variant_failures)}
                        </span>
                      ) : null}
                      <Button
                        size="sm"
                        onClick={() =>
                          props.onUsed(candidate.media_id!, candidate.media_variant_failures)
                        }
                      >
                        {t("media.studio_use")}
                      </Button>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : null}
        {run === null ? (
          <EmptyState title={t("media.studio_empty_preview")} hint={t("media.studio_empty_hint")} />
        ) : null}

        <h3>{t("media.studio_history")}</h3>
        <div className="pcms-mediagrid">
          {(history ?? []).map((item) => (
            <div key={item.id} className="pcms-mediagrid__card">
              <span className="pcms-mediagrid__thumb">
                <img
                  src={`/api/v1/media/${item.id}/file?preview=thumbnail`}
                  alt=""
                  loading="lazy"
                />
              </span>
              {item.provenance?.prompt !== undefined && item.provenance.prompt !== null ? (
                <Button
                  size="sm"
                  onClick={() => {
                    // Restore prompt + params from provenance → regenerate
                    // with edits (owner requirement: paid images are never
                    // lost, iteration reuses the recipe).
                    setPrompt(item.provenance?.prompt ?? "");
                    setSeed(
                      item.provenance?.seed === null || item.provenance?.seed === undefined
                        ? ""
                        : String(item.provenance.seed),
                    );
                    const settings = item.provenance?.settings;
                    if (settings?.resolution) setTier(settings.resolution);
                    if (settings?.aspect) setRatio(settings.aspect);
                  }}
                >
                  {t("media.studio_restore")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Reference picker (img2img, plan T4.1): images from the canonical
 *  library — bytes ride the server-side reference resolution, URLs never
 *  leave the CMS. */
function ReferencePickerDialog(props: {
  readonly onPick: (mediaId: string) => void;
  readonly onClose: () => void;
}) {
  const [items, setItems] = useState<readonly HistoryItem[] | null>(null);

  useEffect(() => {
    apiGet<{ items: readonly HistoryItem[] }>("/media?kind=image&limit=24")
      .then((result) => setItems(result.items))
      .catch(() => setItems([]));
  }, []);

  return (
    <Dialog open onClose={props.onClose} title={t("media.studio_reference_pick")} wide>
      {items === null ? <Spinner /> : null}
      {items !== null && items.length === 0 ? (
        <EmptyState title={t("media.studio_reference_empty")} />
      ) : null}
      <div className="pcms-mediagrid">
        {(items ?? []).map((item) => (
          <div key={item.id} className="pcms-mediagrid__card">
            <button
              type="button"
              className="pcms-studio__ref"
              onClick={() => {
                props.onPick(item.id);
                props.onClose();
              }}
            >
              <img src={`/api/v1/media/${item.id}/file?preview=thumbnail`} alt="" loading="lazy" />
            </button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
