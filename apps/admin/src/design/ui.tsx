// Progressive Admin Design System — base components (Admin spec §2, PCMS-ADMIN-T001).
// Semantic, token-styled, keyboard/ARIA-first building blocks shared by every
// Admin screen. Presentation only: no data fetching, no business logic.
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useContext,
  useId,
} from "react";
import { t } from "../i18n/index.js";
import { type AdminIconName, adminIcons } from "./icons.js";

export type { AdminIconName };

/* --- Icon (central registry, Font Awesome Free 7 self-hosted) --- */

export function Icon(props: {
  readonly name: AdminIconName;
  /** When set, the icon is announced with this label; otherwise decorative. */
  readonly label?: string;
  /** Native hover tooltip (used together with `label` on status icons). */
  readonly title?: string;
  readonly className?: string;
}) {
  const classes = ["pcms-icon", "fa-solid", `fa-${adminIcons[props.name]}`, props.className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: img role carries the label
    <span
      className={classes}
      role={props.label === undefined ? undefined : "img"}
      aria-label={props.label}
      aria-hidden={props.label === undefined ? true : undefined}
      title={props.title}
    />
  );
}

/** Domain accent CSS vars for icon tiles / accent highlights. */
export type DomainAccent =
  | "content"
  | "media"
  | "navigation"
  | "publication"
  | "search"
  | "interactions"
  | "integrations"
  | "payments"
  | "theme"
  | "access"
  | "audit"
  | "system";

export function accentVars(accent: DomainAccent): CSSProperties {
  return {
    "--pcms-icon-accent": `var(--pcms-admin-domain-${accent})`,
    "--pcms-icon-soft": `var(--pcms-admin-domain-${accent}-soft)`,
  } as CSSProperties;
}

/** Colored domain icon tile (Overview widgets, empty states). */
export function IconTile(props: {
  readonly icon: AdminIconName;
  readonly accent: DomainAccent;
  readonly size?: "md" | "lg";
}) {
  return (
    <span
      className={props.size === "lg" ? "pcms-icontile pcms-icontile--lg" : "pcms-icontile"}
      style={accentVars(props.accent)}
    >
      <Icon name={props.icon} />
    </span>
  );
}

/* --- Button --- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: "primary" | "secondary" | "danger" | "ghost";
  readonly size?: "md" | "sm";
  /** React 19: ref travels as a regular prop for focus restoration. */
  readonly ref?: React.Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...rest
}: ButtonProps) {
  const classes = ["pcms-btn", `pcms-btn--${variant}`, size === "sm" ? "pcms-btn--sm" : ""]
    .filter(Boolean)
    .join(" ");
  return <button type="button" className={`${classes} ${className}`.trim()} {...rest} />;
}

/* --- Field: label + control + hint + error (ids wired for aria) --- */

interface FieldContextValue {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

function useFieldControl(): FieldContextValue | null {
  return useContext(FieldContext);
}

export function Field(props: {
  readonly label: ReactNode;
  readonly required?: boolean;
  /** Compact "optional" marker in the label row (spec §16.1) — not a
   * dedicated hint line. */
  readonly optional?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [
    props.hint === undefined ? null : hintId,
    props.error === undefined ? null : errorId,
  ]
    .filter(Boolean)
    .join(" ");
  const context: FieldContextValue = {
    id,
    describedBy: describedBy === "" ? undefined : describedBy,
    invalid: props.error !== undefined,
  };
  return (
    <div className="pcms-field">
      <div className="pcms-field__label-row">
        <label
          className={
            props.required === true
              ? "pcms-field__label pcms-field__label--required"
              : "pcms-field__label"
          }
          htmlFor={id}
        >
          {props.label}
        </label>
        {props.optional === true ? (
          <span className="pcms-field__meta">{t("field_optional")}</span>
        ) : null}
      </div>
      <FieldContext.Provider value={context}>{props.children}</FieldContext.Provider>
      {props.hint === undefined ? null : (
        <div className="pcms-field__hint" id={hintId}>
          {props.hint}
        </div>
      )}
      {props.error === undefined ? null : (
        <div className="pcms-field__error" id={errorId} role="alert">
          {props.error}
        </div>
      )}
    </div>
  );
}

export function Input(props: Omit<InputHTMLAttributes<HTMLInputElement>, "id">) {
  const field = useFieldControl();
  const { "aria-describedby": describedBy, ...rest } = props;
  if (field === null) {
    return <input className="pcms-input" {...props} />;
  }
  const described = [field.describedBy, describedBy].filter(Boolean).join(" ");
  return (
    <input
      id={field.id}
      className="pcms-input"
      aria-describedby={described === "" ? undefined : described}
      aria-invalid={field.invalid || undefined}
      {...rest}
    />
  );
}

export function Textarea(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">) {
  const field = useFieldControl();
  if (field === null) {
    return <textarea className="pcms-textarea" {...props} />;
  }
  return (
    <textarea
      id={field.id}
      className="pcms-textarea"
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      {...props}
    />
  );
}

export function Select(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, "id">) {
  const field = useFieldControl();
  if (field === null) {
    return <select className="pcms-select" {...props} />;
  }
  return (
    <select
      id={field.id}
      className="pcms-select"
      aria-describedby={field.describedBy}
      aria-invalid={field.invalid || undefined}
      {...props}
    />
  );
}

export function Switch(props: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly label: string;
}) {
  const id = useId();
  return (
    <span className="pcms-switch">
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={props.checked}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <label htmlFor={id}>{props.label}</label>
    </span>
  );
}

/* --- Badge + StatusBadge --- */

export function Badge(props: {
  readonly tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "violet";
  readonly children: ReactNode;
}) {
  const tone =
    props.tone === undefined || props.tone === "neutral" ? "" : ` pcms-badge--${props.tone}`;
  return <span className={`pcms-badge${tone}`}>{props.children}</span>;
}

/** Status as pill + icon: color never carries the state alone (spec §14). */
export function StatusBadge(props: {
  readonly tone: "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "violet";
  readonly icon?: AdminIconName;
  readonly children: ReactNode;
}) {
  return (
    <span className={`pcms-badge pcms-badge--status pcms-badge--${props.tone}`}>
      {props.icon === undefined ? <span className="pcms-badge__dot" aria-hidden="true" /> : null}
      {props.icon === undefined ? null : <Icon name={props.icon} className="pcms-badge__icon" />}
      {props.children}
    </span>
  );
}

/* --- Card --- */

export function Card(props: {
  readonly title?: string;
  /** Large colored icon tile shown in the title banner (extension cards). */
  readonly icon?: AdminIconName;
  readonly accent?: DomainAccent;
  readonly children: ReactNode;
}) {
  return (
    <section
      className="pcms-card"
      style={props.icon !== undefined ? accentVars(props.accent ?? "system") : undefined}
    >
      {props.title === undefined ? null : props.icon !== undefined ? (
        <h3 className="pcms-card__title pcms-card__title--banner">
          <span className="pcms-icontile pcms-icontile--xl">
            <Icon name={props.icon} />
          </span>
          <span>{props.title}</span>
        </h3>
      ) : (
        <h3 className="pcms-card__title">{props.title}</h3>
      )}
      {props.children}
    </section>
  );
}

/* --- Spinner + async states --- */

export function Spinner(props: { readonly label?: string }) {
  return (
    <span className="pcms-state" role="status" aria-live="polite" aria-atomic="true">
      <span className="pcms-spinner" aria-hidden="true" />
      <span>{props.label ?? t("core.loading")}</span>
    </span>
  );
}

export function EmptyState(props: {
  readonly title: string;
  readonly hint?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="pcms-state">
      <h3>{props.title}</h3>
      {props.hint === undefined ? null : <p>{props.hint}</p>}
      {props.action}
    </div>
  );
}

/** Recoverable or fatal error presentation with support reference (spec §62). */
export function ErrorPanel(props: {
  readonly title?: string;
  readonly message: string;
  readonly requestId?: string | null;
  readonly onRetry?: () => void;
  readonly details?: string;
}) {
  return (
    <div className="pcms-state pcms-state--error" role="alert">
      <h3>{props.title ?? t("core.operation_failed")}</h3>
      <p>{props.message}</p>
      {props.requestId === undefined || props.requestId === null ? null : (
        <p>
          {t("core.request_id")} <code>{props.requestId}</code>
        </p>
      )}
      {props.details === undefined ? null : (
        <details>
          <summary>{t("core.technical_details")}</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{props.details}</pre>
        </details>
      )}
      {props.onRetry === undefined ? null : (
        <Button onClick={props.onRetry}>{t("core.retry")}</Button>
      )}
    </div>
  );
}

/* --- Tabs (roving arrow-key selection, ARIA tabs pattern) --- */

export interface TabItem {
  readonly id: string;
  readonly title: string;
}

export function Tabs(props: {
  readonly items: readonly TabItem[];
  readonly active: string;
  readonly onSelect: (id: string) => void;
  readonly label: string;
}) {
  const move = (event: React.KeyboardEvent, direction: 1 | -1) => {
    const index = props.items.findIndex((item) => item.id === props.active);
    if (index === -1) return;
    const next = (index + direction + props.items.length) % props.items.length;
    const target = props.items[next];
    if (target !== undefined) {
      props.onSelect(target.id);
      event.currentTarget.parentElement
        ?.querySelector<HTMLButtonElement>(`#tab-${target.id}`)
        ?.focus();
      event.preventDefault();
    }
  };
  return (
    <div className="pcms-tabs" role="tablist" aria-label={props.label}>
      {props.items.map((item) => (
        <button
          key={item.id}
          id={`tab-${item.id}`}
          type="button"
          role="tab"
          className="pcms-tab"
          aria-selected={item.id === props.active}
          aria-controls={`panel-${item.id}`}
          tabIndex={item.id === props.active ? 0 : -1}
          onClick={() => props.onSelect(item.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") move(event, 1);
            if (event.key === "ArrowLeft") move(event, -1);
          }}
        >
          {item.title}
        </button>
      ))}
    </div>
  );
}

export function TabPanel(props: {
  readonly id: string;
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  if (!props.active) return null;
  return (
    <div id={`panel-${props.id}`} role="tabpanel" aria-labelledby={`tab-${props.id}`}>
      {props.children}
    </div>
  );
}

/* --- IconButton: icon-only with mandatory accessible name + tooltip --- */

export function IconButton(props: {
  readonly icon: AdminIconName;
  /** Accessible name; doubles as the tooltip text (spec §21.4 invariant). */
  readonly label: string;
  readonly onClick?: () => void;
  readonly variant?: "ghost" | "secondary" | "danger";
  readonly small?: boolean;
  readonly disabled?: boolean | undefined;
  readonly active?: boolean;
  readonly testid?: string;
  readonly className?: string;
  readonly ariaExpanded?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
}) {
  const classes = [
    "pcms-iconbtn",
    props.variant === undefined ? "" : `pcms-iconbtn--${props.variant}`,
    props.small === true ? "pcms-iconbtn--sm" : "",
    props.active === true ? "pcms-iconbtn--active" : "",
    props.className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      ref={props.ref}
      type="button"
      className={classes}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active === true ? true : undefined}
      aria-expanded={props.ariaExpanded}
      disabled={props.disabled}
      data-testid={props.testid}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  );
}

/* --- Skeleton: layout-approximating loading block, not a spinner --- */

export function Skeleton(props: { readonly w?: string; readonly h?: string }) {
  return (
    <span
      className="pcms-skeleton"
      style={{ width: props.w, height: props.h ?? "1em" }}
      aria-hidden="true"
    />
  );
}
