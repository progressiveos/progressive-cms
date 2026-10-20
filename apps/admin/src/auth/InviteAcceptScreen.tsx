// Invite acceptance (PCMS-ADMIN-T020): single-use token → set first password.
// The token IS the credential; the password policy is enforced server-side.
import { type FormEvent, useState } from "react";
import { apiPost } from "../api/client.js";
import { Button, ErrorPanel, Field, Input } from "../design/ui.js";
import { t } from "../i18n/index.js";
import { navigate, useRoute } from "../layout/router.js";

export function InviteAcceptScreen(props: { readonly authenticated?: boolean }) {
  const route = useRoute();
  const token = route.segments[1] ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError(t("access.invite_password_mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost("/auth/invite/accept", { invite_token: token, password });
      setDone(true);
      setTimeout(() => navigate("/"), 1500);
    } catch {
      setError(t("access.invite_accept_failed"));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <main className="pcms-login">
        <div className="pcms-login__card">
          <h1>{t("access.invite_done_title")}</h1>
          <p>{t("access.invite_done_text")}</p>
          <Button variant="primary" onClick={() => navigate("/")}>
            {t("access.invite_done_button")}
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="pcms-login">
      <form className="pcms-login__card" onSubmit={submit}>
        <h1>{t("access.invite_screen_title")}</h1>
        {props.authenticated === true ? (
          <p className="pcms-field__hint">{t("access.invite_authenticated_hint")}</p>
        ) : null}
        {token === "" ? (
          <ErrorPanel message={t("access.invite_missing_token")} />
        ) : (
          <>
            <Field
              label={t("access.field_new_password")}
              required
              hint={t("access.invite_password_hint")}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </Field>
            <Field label={t("access.field_confirm_password")} required>
              <Input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
              />
            </Field>
            {error === null ? null : <ErrorPanel message={error} />}
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "…" : t("access.set_password_button")}
            </Button>
          </>
        )}
      </form>
      <p className="pcms-copyright">
        <a href={t("copyright_url")} target="_blank" rel="noreferrer">
          {t("copyright_label")}
        </a>
      </p>
    </main>
  );
}
