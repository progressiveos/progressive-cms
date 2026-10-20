// Editor translations strip (opt-in multilingual; PCMS localization work
// package #22–#24): language versions of the same logical entry, rendered
// only when the site runs in multilingual mode. Language versions are
// entries of one translation group; "Add translation" creates an empty or
// copied working draft — publication stays per-locale.
import { useCallback, useEffect, useState } from "react";
import { useBootstrap } from "../../api/bootstrap.js";
import { apiGet, apiPost } from "../../api/client.js";
import { Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import { Button, Field, Select, Spinner } from "../../design/ui.js";
import { errorText, t } from "../../i18n/index.js";
import { navigate } from "../../layout/router.js";

interface TranslationWire {
  readonly entry_id: string;
  readonly locale: string;
  readonly archived: boolean;
}

export function TranslationsStrip(props: { readonly entryId: string }) {
  const bootstrap = useBootstrap();
  const localization = bootstrap?.localization;
  const multilingual = localization?.mode === "multilingual";
  const toast = useToast();
  const [members, setMembers] = useState<TranslationWire[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [targetLocale, setTargetLocale] = useState<string>("");
  const [copySource, setCopySource] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await apiGet<{ items: TranslationWire[] }>(
        `/entries/${props.entryId}/translations`,
      );
      setMembers(page.items);
    } catch {
      setMembers([]);
    }
  }, [props.entryId]);

  useEffect(() => {
    if (multilingual) void load();
  }, [multilingual, load]);

  if (!multilingual) return null;
  if (members === null) return <Spinner />;

  const existing = new Set(members.map((member) => member.locale));
  const candidates = (localization?.enabled_locales ?? []).filter(
    (locale) => !existing.has(locale),
  );

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ entry_id: string }>(`/entries/${props.entryId}/translations`, {
        locale: targetLocale,
        copy_from_source: copySource,
      });
      void load();
      setDialogOpen(false);
      toast(t("localization.created_toast", { locale: targetLocale }), "success");
      navigate(`/content/${result.entry_id}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? (errorText((cause as { code?: string }).code ?? "") ?? cause.message)
          : String(cause),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pcms-row" data-testid="translations-strip" style={{ flexWrap: "wrap" }}>
      <span className="pcms-text-muted">{t("localization.translations")}:</span>
      {members.map((member) => (
        <Button
          key={member.entry_id}
          size="sm"
          variant={member.entry_id === props.entryId ? "primary" : "ghost"}
          disabled={member.archived}
          onClick={() => navigate(`/content/${member.entry_id}`)}
        >
          {member.locale}
        </Button>
      ))}
      {candidates.length > 0 && (
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          {t("localization.add_translation")}
        </Button>
      )}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={t("localization.add_translation")}
      >
        <div className="pcms-stack">
          <Field label={t("localization.locale_label")}>
            <Select value={targetLocale} onChange={(event) => setTargetLocale(event.target.value)}>
              <option value="" />
              {candidates.map((locale) => (
                <option key={locale} value={locale}>
                  {locale}
                </option>
              ))}
            </Select>
          </Field>
          <label className="pcms-field">
            <input
              type="checkbox"
              checked={copySource}
              onChange={(event) => setCopySource(event.target.checked)}
            />{" "}
            {t("localization.copy_source")}
          </label>
          {error !== null && (
            <p role="alert" className="pcms-text-muted">
              {error}
            </p>
          )}
          <div className="pcms-row">
            <Button
              variant="primary"
              disabled={targetLocale === "" || busy}
              onClick={() => void create()}
            >
              {t("localization.create")}
            </Button>
            <Button onClick={() => setDialogOpen(false)}>{t("cancel")}</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
