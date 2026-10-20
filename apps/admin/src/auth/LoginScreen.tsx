// Login screen (Admin spec §43; redesign concept §20, spec §25): split
// workspace composition — brand gradient panel with the local Progressive OS
// lockup, neutral auth form, pre-auth theme + locale controls, build-version
// metadata. No deployment details in product copy. Enumeration-safe errors
// surface as the API words them; post-login landing is always the dashboard —
// never a URL-supplied redirect target.
import { type FormEvent, useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import {
  type AdminAppearance,
  getAppearance,
  onAppearanceChange,
  setAppearance,
} from "../design/theme.js";
import { Button, ErrorPanel, Field, Icon, IconButton, Input } from "../design/ui.js";
import { errorText, t } from "../i18n/index.js";
import { getLocale, setLocale } from "../i18n/locale.js";
import { useAuth } from "./AuthContext.js";

// Injected at build time from package.json (vite define).
declare const __PCMS_ADMIN_VERSION__: string;
const PCMS_VERSION: string =
  typeof __PCMS_ADMIN_VERSION__ === "string" ? __PCMS_ADMIN_VERSION__ : "";

/** Pre-auth quick controls: locale segmented switch + appearance cycler
 * (light → dark → system). The full popover lives in the admin topbar. */
function LoginControls() {
  const [preference, setPreference] = useState<AdminAppearance>(() => getAppearance());
  useEffect(() => onAppearanceChange(setPreference), []);
  return (
    <div className="pcms-login__controls">
      {/* biome-ignore lint/a11y/useSemanticElements: segmented control, not a fieldset */}
      <div className="pcms-locale" role="group" aria-label={t("topbar_locale")}>
        <button
          type="button"
          className="pcms-locale__option"
          aria-pressed={getLocale() === "ru"}
          onClick={() => setLocale("ru")}
        >
          RU
        </button>
        <button
          type="button"
          className="pcms-locale__option"
          aria-pressed={getLocale() === "en"}
          onClick={() => setLocale("en")}
        >
          EN
        </button>
      </div>
      <IconButton
        icon={preference === "dark" ? "moon" : preference === "light" ? "sun" : "monitor"}
        label={t("topbar_theme")}
        onClick={() => {
          const order: readonly AdminAppearance[] = ["light", "dark", "system"];
          const next = order[(order.indexOf(preference) + 1) % order.length] ?? "system";
          setPreference(next);
          setAppearance(next);
        }}
      />
    </div>
  );
}

export function LoginScreen() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  const describe = (caught: unknown): string => {
    if (caught instanceof ApiError) {
      return errorText(caught.code) ?? caught.message;
    }
    return t("login_unexpected_error");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setRequestId(null);
    try {
      await auth.login(email, password);
    } catch (caught) {
      setError(describe(caught));
      if (caught instanceof ApiError) setRequestId(caught.requestId);
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setRequestId(null);
    try {
      await auth.confirmMfa(code);
    } catch (caught) {
      setError(describe(caught));
      if (caught instanceof ApiError) setRequestId(caught.requestId);
    } finally {
      setBusy(false);
    }
  };

  const chips = (
    <div className="pcms-login__chips">
      <span className="pcms-login__chip">
        <Icon name="content" /> {t("nav_content")}
      </span>
      <span className="pcms-login__chip">
        <Icon name="media" /> {t("nav_media")}
      </span>
      <span className="pcms-login__chip">
        <Icon name="publication" /> {t("nav_publication")}
      </span>
    </div>
  );

  if (auth.state.status === "mfa") {
    return (
      <main className="pcms-login">
        <section className="pcms-login__brand" aria-hidden="true">
          <img className="pcms-login__logo" src="/admin/brand/lockup-white.svg" alt="" />
          {chips}
        </section>
        <section className="pcms-login__panel">
          <div className="pcms-login__controls-row">
            <LoginControls />
          </div>
          <form className="pcms-login__card" onSubmit={submitMfa}>
            <img
              className="pcms-login__form-mark"
              src="/admin/brand/mark-2026.svg"
              alt=""
              aria-hidden="true"
            />
            <h1>{t("login_mfa_title")}</h1>
            <p className="pcms-login__subtitle">{t("login_mfa_hint")}</p>
            {error === null ? null : <ErrorPanel message={error} requestId={requestId} />}
            <Field label={t("login_mfa_code")} required>
              <Input
                name="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={10}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
            </Field>
            <Button variant="primary" type="submit" disabled={busy || code.length === 0}>
              {busy ? t("login_signing_in") : t("login_mfa_submit")}
            </Button>
          </form>
          <p className="pcms-copyright">
            <a href={t("copyright_url")} target="_blank" rel="noreferrer">
              {t("copyright_label")}
            </a>
          </p>
          <p className="pcms-login__version">
            Progressive CMS{PCMS_VERSION === "" ? "" : ` · v${PCMS_VERSION}`}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="pcms-login">
      <section className="pcms-login__brand" aria-hidden="true">
        <img className="pcms-login__logo" src="/admin/brand/lockup-white.svg" alt="" />
        <p className="pcms-login__message">{t("login_brand_message")}</p>
        {chips}
      </section>
      <section className="pcms-login__panel">
        <div className="pcms-login__controls-row">
          <LoginControls />
        </div>
        <form className="pcms-login__card" onSubmit={submit}>
          <img
            className="pcms-login__form-mark"
            src="/admin/brand/mark-2026.svg"
            alt=""
            aria-hidden="true"
          />
          <h1>{t("login_title")}</h1>
          <p className="pcms-login__subtitle">{t("login_subtitle")}</p>
          {error === null ? null : <ErrorPanel message={error} requestId={requestId} />}
          <Field label={t("login_email")} required>
            <Input
              type="email"
              name="email"
              autoComplete="username"
              autoFocus
              maxLength={320}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field label={t("login_password")} required>
            <span className="pcms-password">
              <Input
                type={reveal ? "text" : "password"}
                name="password"
                autoComplete="current-password"
                maxLength={1024}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <IconButton
                small
                icon={reveal ? "hide" : "preview"}
                label={reveal ? t("login_hide_password") : t("login_show_password")}
                onClick={() => setReveal((value) => !value)}
              />
            </span>
          </Field>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? t("login_signing_in") : t("login_submit")}
          </Button>
        </form>
        <p className="pcms-copyright">
          <a href={t("copyright_url")} target="_blank" rel="noreferrer">
            {t("copyright_label")}
          </a>
        </p>
        <p className="pcms-login__version">
          Progressive CMS{PCMS_VERSION === "" ? "" : ` · v${PCMS_VERSION}`}
        </p>
      </section>
    </main>
  );
}
