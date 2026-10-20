import { useState } from "react";
import { apiPost } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { ConfirmDialog } from "../../design/dialog.js";
import { Button } from "../../design/ui.js";
import { t } from "../../i18n/index.js";

interface CleanupPlan {
  ok: boolean;
  theme_generation: number;
  keep_last: number;
  older_than_days: number;
  has_more: boolean;
  candidates: { revision_id: string; theme_id: string; package_version: string }[];
  removed: string[];
  pending: string[];
}

export function ThemeHistoryCleanup() {
  const auth = useAuth();
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  if (!auth.can("theme.read")) return null;
  const preview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setPlan(null);
    setSelected([]);
    try {
      const preview = await apiPost<CleanupPlan>("/themes/revisions/cleanup", { dry_run: true });
      setPlan(preview);
      setSelected(preview.candidates.map((row) => row.revision_id));
    } catch (error) {
      setError(error instanceof Error ? error.message : t("theme_cleanup_failed"));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!plan || !selected.length) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiPost<CleanupPlan>("/themes/revisions/cleanup", {
        dry_run: false,
        keep_last: plan.keep_last,
        older_than_days: plan.older_than_days,
        expected_generation: plan.theme_generation,
        revision_ids: selected,
      });
      setConfirm(false);
      setPlan(null);
      setResult(
        t("theme_cleanup_result", {
          removed: response.removed.length,
          pending: response.pending.length,
        }),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : t("theme_cleanup_failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="pcms-panel" data-testid="theme-history-cleanup">
      <h3>{t("theme_cleanup_title")}</h3>
      <p className="pcms-field__hint">{t("theme_cleanup_hint")}</p>
      <Button disabled={busy} onClick={() => void preview()}>
        {t("theme_cleanup_preview")}
      </Button>
      {error && <p role="alert">{error}</p>}
      {result && <p role="status">{result}</p>}
      {plan && (
        <>
          <p role="status">{t("theme_cleanup_candidates", { count: plan.candidates.length })}</p>
          {plan.candidates.length > 0 && (
            <>
              <ul>
                {plan.candidates.map((row) => (
                  <li key={row.revision_id}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={selected.includes(row.revision_id)}
                        onChange={(event) =>
                          setSelected((ids) =>
                            event.target.checked
                              ? [...ids, row.revision_id]
                              : ids.filter((id) => id !== row.revision_id),
                          )
                        }
                      />
                      {row.theme_id} {row.package_version} — <code>{row.revision_id}</code>
                    </label>
                  </li>
                ))}
              </ul>
              {auth.can("theme.write") && (
                <Button disabled={busy || selected.length === 0} onClick={() => setConfirm(true)}>
                  {t("theme_cleanup_delete")}
                </Button>
              )}
            </>
          )}
          {plan.has_more && <p>{t("theme_cleanup_more")}</p>}
        </>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => {
          if (!busy) setConfirm(false);
        }}
        onConfirm={() => void apply()}
        title={t("theme_cleanup_delete")}
        body={t("theme_cleanup_warning")}
        confirmLabel={t("theme_cleanup_delete")}
        tone="danger"
        busy={busy}
        error={error}
      />
    </section>
  );
}
