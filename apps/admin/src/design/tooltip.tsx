// Tooltip (redesign spec §21): text-only, hover + keyboard focus, ~300ms open
// delay, Escape dismiss, fixed positioning via portal (overflow-safe).
// Interactive content belongs in a Popover, not here. The anchor span carries
// the events; React focus handlers bubble (focusin), so wrapped controls work
// untouched.
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Placement = "top" | "bottom" | "left" | "right";

const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 80;

function position(anchor: DOMRect, tip: HTMLElement, placement: Placement): void {
  const gap = 8;
  const { width, height } = tip.getBoundingClientRect();
  let top: number;
  let left: number;
  switch (placement) {
    case "bottom":
      top = anchor.bottom + gap;
      left = anchor.left + anchor.width / 2 - width / 2;
      break;
    case "left":
      top = anchor.top + anchor.height / 2 - height / 2;
      left = anchor.left - width - gap;
      break;
    case "right":
      top = anchor.top + anchor.height / 2 - height / 2;
      left = anchor.right + gap;
      break;
    default:
      top = anchor.top - height - gap;
      left = anchor.left + anchor.width / 2 - width / 2;
  }
  const margin = 8;
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
}

export function Tooltip(props: {
  readonly content: string;
  readonly children: ReactNode;
  readonly placement?: Placement;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const tooltipId = useId();

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, []);
  const hideNow = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useEffect(() => hideNow, [hideNow]);

  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (anchor !== null && tip !== null) {
      position(anchor.getBoundingClientRect(), tip, props.placement ?? "top");
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideNow();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, props.placement, hideNow]);

  return (
    /* biome-ignore lint/a11y/noStaticElementInteractions: anchor carries the tooltip hover/focus for the wrapped interactive control (APG tooltip) */
    <span
      ref={anchorRef}
      className="pcms-tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape") hideNow();
      }}
    >
      {props.children}
      {open
        ? createPortal(
            <div ref={tipRef} id={tooltipId} role="tooltip" className="pcms-tooltip">
              {props.content}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
