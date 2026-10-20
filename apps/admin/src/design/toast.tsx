// Toast notifications (Admin spec §62; redesign spec §3.3): transient
// feedback with semantic tones. Toasts never replace inline field errors —
// they cover out-of-band failures and confirmations. success/info auto-dismiss
// quickly; warning lingers; error stays longest and is dismissible.
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { type AdminIconName, Icon } from "./ui.js";

export type ToastTone = "info" | "success" | "warning" | "error";

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
}

type ToastApi = (text: string, tone?: ToastTone) => void;

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (value === null) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return value;
}

const TONE_ICON: Record<ToastTone, AdminIconName> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
};

const TONE_MS: Record<ToastTone, number> = {
  info: 4000,
  success: 4000,
  warning: 8000,
  error: 10000,
};

export function ToastProvider(props: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback<ToastApi>(
    (text, tone = "info") => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current, { id, text, tone }]);
      setTimeout(() => dismiss(id), TONE_MS[tone]);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {props.children}
      <div className="pcms-toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`pcms-toast pcms-toast--${toast.tone}`}>
            <Icon name={TONE_ICON[toast.tone]} className="pcms-toast__icon" />
            <span className="pcms-toast__text">{toast.text}</span>
            <button
              type="button"
              className="pcms-toast__close"
              aria-label={t("close")}
              onClick={() => dismiss(toast.id)}
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
