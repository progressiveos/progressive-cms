// Publication tab (PCMS-ADMIN-T009; Admin spec §22/§23/§34; redesign §24).
// Structural separation is mandatory: save working → validate → seal →
// preview → publish → unpublish are distinct actions with distinct buttons
// and permissions — the UI never conflates them into one Save. Public
// mutations (publish/unpublish) run through ConfirmDialogs and wait for the
// server before any state change.
import { useCallback, useEffect, useState } from "react";
import { useBootstrap } from "../../../api/bootstrap.js";
import { ApiError, apiGet, apiPost, describeApiError } from "../../../api/client.js";
import { useAuth } from "../../../auth/AuthContext.js";
import { ConfirmDialog } from "../../../design/dialog.js";
import { useToast } from "../../../design/toast.js";
import { Tooltip } from "../../../design/tooltip.js";
import { Badge, Button, EmptyState, Spinner, StatusBadge } from "../../../design/ui.js";
import { formatDateTime, t } from "../../../i18n/index.js";
import { loadEntryTitles } from "../fields/pickers.js";

interface PublicationWire {
  readonly state: "PUBLISHED" | "UNPUBLISHED";
  readonly current_revision_id: string | null;
  readonly generation: number;
  readonly published_at: string | null;
}

interface ValidateResult {
  readonly ok: boolean;
  readonly issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly severity: string;
  }[];
}

type PendingAction = { readonly kind: "publish" } | { readonly kind: "unpublish" } | null;

export function PublicationTab(props: {
  readonly entryId: string;
  readonly revisionId: string | null;
  readonly revisionState: "WORKING" | "SEALED" | null;
  readonly generation: number;
  readonly onPublicationChanged: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const bootstrap = useBootstrap();
  const [publication, setPublication] = useState<PublicationWire | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [entryTitle, setEntryTitle] = useState<string | null>(null);

  const reload = useCallback(() => {
    apiGet<PublicationWire>(`/publications/entry/${props.entryId}`)
      .then((result) => {
        setPublication(result);
        setLoaded(true);
      })
      .catch(() => {
        setPublication(null);
        setLoaded(true);
      });
  }, [props.entryId]);

  useEffect(reload, [reload]);
  useEffect(() => {
    let cancelled = false;
    loadEntryTitles()
      .then((titles) => {
        if (!cancelled) setEntryTitle(titles.get(props.entryId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.entryId]);

  const environment =
    bootstrap === null
      ? null
      : bootstrap.environment.classification === "production"
        ? t("env_production")
        : t("env_development");

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setPendingError(null);
    try {
      await action();
      toast(success, "success");
      setPending(null);
      reload();
      props.onPublicationChanged();
    } catch (caught) {
      // The confirm stays open with the failure inside — no silent toast path.
      // Validation issues ride the envelope details; show them (owner: the
      // human must SEE what is wrong, 2026-10-06).
      setPendingError(
        caught instanceof ApiError ? describeApiError(caught) : t("publication_failed_generic"),
      );
    } finally {
      setBusy(false);
    }
  };

  const validate = async () => {
    if (props.revisionId === null) return;
    setValidating(true);
    try {
      const result = await apiPost<ValidateResult>(`/revisions/${props.revisionId}/validate`, {});
      setValidation(result);
    } catch {
      toast(t("validate_failed"), "error");
    } finally {
      setValidating(false);
    }
  };

  if (!loaded) return <Spinner />;
  if (props.revisionId === null) {
    return (
      <EmptyState title={t("publication_no_revision")} hint={t("publication_no_revision_hint")} />
    );
  }

  const isPublished = publication?.state === "PUBLISHED";
  const canSeal = auth.can("revision.seal") && props.revisionState === "WORKING";
  const canPreview = auth.can("preview.create") && props.revisionState === "SEALED";
  const canPublish = auth.can("publication.publish") && props.revisionState === "SEALED";
  const canUnpublish = auth.can("publication.unpublish") && isPublished;

  // Draft vs publish validation (Admin spec §22): distinct human states —
  // "Draft saved / Ready to seal / Ready to publish" never conflate.
  const stateBadge =
    props.revisionState === "WORKING" ? (
      validation === null ? (
        <StatusBadge tone="info" icon="edit">
          {t("publication_state_draft_saved")}
        </StatusBadge>
      ) : validation.ok ? (
        <StatusBadge tone="info" icon="check">
          {t("publication_state_draft_checked")}
        </StatusBadge>
      ) : (
        <StatusBadge tone="danger" icon="warning">
          {t("publication_state_draft_errors")}
        </StatusBadge>
      )
    ) : validation === null ? (
      <Tooltip content={t("revision_sealed_definition")}>
        <StatusBadge tone="warning" icon="lock">
          {t("publication_state_sealed_unchecked")}
        </StatusBadge>
      </Tooltip>
    ) : validation.ok ? (
      <StatusBadge tone="success" icon="check">
        {t("publication_state_ready")}
      </StatusBadge>
    ) : (
      <StatusBadge tone="danger" icon="warning">
        {t("publication_state_errors")}
      </StatusBadge>
    );

  const openPreview = async () => {
    if (props.revisionId === null) return;
    try {
      const result = await apiPost<{ token: string }>("/previews", {
        scope: {
          kind: "revision",
          entity_type: "entry",
          entity_id: props.entryId,
          revision_id: props.revisionId,
        },
      });
      window.open(`/preview/page?token=${encodeURIComponent(result.token)}`, "_blank", "noopener");
    } catch {
      toast(t("preview_failed"), "error");
    }
  };

  return (
    <div data-testid="publication-tab" className="pcms-publication">
      <div className="pcms-toolbar">
        {stateBadge}
        <span className="pcms-toolbar__spacer" />
        <Button size="sm" disabled={validating} onClick={() => void validate()}>
          {t("publication_validate")}
        </Button>
        <Tooltip content={t("seal_definition")}>
          <Button
            size="sm"
            variant="secondary"
            disabled={!canSeal || busy}
            onClick={() =>
              void run(
                () =>
                  apiPost(`/revisions/${props.revisionId}/seal`, {
                    expected_edit_generation: props.generation,
                  }),
                t("seal_done"),
              )
            }
          >
            {t("publication_seal")}
          </Button>
        </Tooltip>
        <Button
          size="sm"
          variant="secondary"
          disabled={!canPreview || busy}
          onClick={() => void openPreview()}
        >
          {t("publication_preview")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!canPublish || busy}
          onClick={() => {
            setPendingError(null);
            setPending({ kind: "publish" });
          }}
        >
          {t("publication_publish")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={!canUnpublish || busy}
          onClick={() => {
            setPendingError(null);
            setPending({ kind: "unpublish" });
          }}
        >
          {t("publication_unpublish")}
        </Button>
      </div>

      {validation !== null && !validation.ok ? (
        <div className="pcms-panel pcms-publication__issues" role="alert">
          <strong>{t("publication_issues_title")}</strong>
          <ul>
            {validation.issues.map((issue) => (
              <li key={`${issue.code}-${issue.message}`}>
                {issue.message} <span className="pcms-picker-row__meta">({issue.code})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="pcms-panel">
        {isPublished ? (
          <p>
            <Badge tone="success">{t("publication_state_published")}</Badge>{" "}
            {t("publication_generation")} {publication?.generation}, {t("publication_revision")}{" "}
            {publication?.current_revision_id?.slice(0, 8)}…, {t("publication_since")}{" "}
            {publication?.published_at === null ? "—" : formatDateTime(publication.published_at)}
          </p>
        ) : publication === null ? (
          <p className="pcms-text-muted">{t("publication_never")}</p>
        ) : (
          <p className="pcms-text-muted">{t("publication_unpublished")}</p>
        )}
      </div>

      <ConfirmDialog
        open={pending?.kind === "publish"}
        onClose={() => {
          setPending(null);
          setPendingError(null);
        }}
        onConfirm={() =>
          void run(
            () =>
              apiPost("/publications/publish", {
                entity_type: "entry",
                entity_id: props.entryId,
                target_revision_id: props.revisionId,
                expected_generation: publication?.generation ?? 0,
              }),
            t("publish_done"),
          )
        }
        title={t("publish_confirm_title")}
        body={t("publish_confirm_body")}
        details={[
          { label: t("publish_confirm_entry"), value: entryTitle ?? props.entryId },
          { label: t("publish_confirm_route"), value: "—" },
          ...(environment === null
            ? []
            : [{ label: t("publish_confirm_env"), value: environment }]),
        ]}
        confirmLabel={t("publication_publish")}
        tone="primary"
        busy={busy}
        error={pendingError}
      />
      <ConfirmDialog
        open={pending?.kind === "unpublish"}
        onClose={() => {
          setPending(null);
          setPendingError(null);
        }}
        onConfirm={() =>
          void run(
            () =>
              apiPost("/publications/unpublish", {
                entity_type: "entry",
                entity_id: props.entryId,
                expected_generation: publication?.generation ?? 0,
              }),
            t("unpublish_done"),
          )
        }
        title={t("unpublish_confirm_title")}
        body={t("unpublish_confirm_body")}
        details={
          environment === null ? [] : [{ label: t("publish_confirm_env"), value: environment }]
        }
        confirmLabel={t("publication_unpublish")}
        tone="danger"
        busy={busy}
        error={pendingError}
      />
    </div>
  );
}
