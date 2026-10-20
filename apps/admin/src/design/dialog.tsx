// Dialog + Drawer + ConfirmDialog with focus management (Admin spec §53,
// redesign spec §3.2): focus moves into the surface on open, is trapped while
// open, restored on close; Escape closes; destructive context is explicit.
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { t } from "../i18n/index.js";
import { Button, Icon } from "./ui.js";

const FOCUSABLE =
  '.pcms-overlay a[href], .pcms-overlay button:not([disabled]), .pcms-overlay input:not([disabled]), .pcms-overlay select:not([disabled]), .pcms-overlay textarea:not([disabled]), .pcms-overlay [tabindex]:not([tabindex="-1"])';

function useSurface(
  open: boolean,
  onClose: () => void,
  closeRef: React.RefObject<HTMLElement | null>,
) {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      restoreRef.current?.focus();
    };
  }, [open, closeRef]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = document.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onKeyDown]);
}

function SurfaceHeader(props: {
  readonly title: string;
  readonly closeLabel?: string | undefined;
  readonly closeRef: React.RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
}) {
  return (
    <div className="pcms-dialog__header">
      <h2>{props.title}</h2>
      <button
        ref={props.closeRef}
        type="button"
        className="pcms-dialog__close pcms-iconbtn"
        aria-label={props.closeLabel ?? t("close")}
        title={props.closeLabel ?? t("close")}
        onClick={props.onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

export function Dialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly closeLabel?: string | undefined;
  readonly wide?: boolean;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useSurface(props.open, props.onClose, closeRef);
  if (!props.open) return null;
  return (
    <div className="pcms-overlay">
      <div
        className={props.wide === true ? "pcms-dialog pcms-dialog--wide" : "pcms-dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <SurfaceHeader
          title={props.title}
          closeLabel={props.closeLabel}
          closeRef={closeRef}
          onClose={props.onClose}
        />
        <div className="pcms-dialog__body">{props.children}</div>
        {props.footer === undefined ? null : (
          <div className="pcms-dialog__footer">{props.footer}</div>
        )}
      </div>
    </div>
  );
}

/** ConfirmDialog for destructive / public / security-sensitive actions
 * (redesign spec §3.1): title, explanation, operation subject rows, explicit
 * verb button, server wait (busy) and API error surface. */
export function ConfirmDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly title: string;
  /** Consequences in plain language. */
  readonly body?: ReactNode;
  /** Subject rows: [{label, value}] — entry, address, environment… */
  readonly details?: readonly { readonly label: string; readonly value: ReactNode }[];
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly tone?: "primary" | "danger";
  /** True while the server round-trip is in flight. */
  readonly busy?: boolean;
  /** Server-side failure shown inside the dialog (no silent toast-only path). */
  readonly error?: string | null;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useSurface(props.open, props.onClose, closeRef);
  if (!props.open) return null;
  return (
    <div className="pcms-overlay">
      <div
        className="pcms-dialog pcms-dialog--confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <SurfaceHeader title={props.title} closeRef={closeRef} onClose={props.onClose} />
        <div className="pcms-dialog__body">
          {props.body === undefined ? null : <div className="pcms-confirm__body">{props.body}</div>}
          {props.details === undefined || props.details.length === 0 ? null : (
            <dl className="pcms-confirm__details">
              {props.details.map((row) => (
                <div key={row.label} className="pcms-confirm__row">
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {props.error === undefined || props.error === null || props.error === "" ? null : (
            <div className="pcms-confirm__error" role="alert">
              {props.error}
            </div>
          )}
        </div>
        <div className="pcms-dialog__footer">
          <Button onClick={props.onClose} disabled={props.busy === true}>
            {props.cancelLabel ?? t("cancel")}
          </Button>
          <Button
            variant={props.tone === "danger" ? "danger" : "primary"}
            onClick={props.onConfirm}
            disabled={props.busy === true}
          >
            {props.busy === true ? t("saving") : props.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Drawer(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly closeLabel?: string | undefined;
  readonly children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useSurface(props.open, props.onClose, closeRef);
  if (!props.open) return null;
  return (
    <div className="pcms-overlay pcms-overlay--drawer">
      <div className="pcms-drawer" role="dialog" aria-modal="true" aria-label={props.title}>
        <SurfaceHeader
          title={props.title}
          closeLabel={props.closeLabel}
          closeRef={closeRef}
          onClose={props.onClose}
        />
        <div className="pcms-dialog__body">{props.children}</div>
      </div>
    </div>
  );
}
