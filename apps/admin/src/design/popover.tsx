// Popover (redesign spec §3.4): anchored floating surface for interactive
// content — menus, quick controls. Closes on outside pointer-down, Escape;
// returns focus to the anchor on close.
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function Popover(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Element the popover is anchored to. */
  readonly anchor: HTMLElement | null;
  readonly children: ReactNode;
  readonly align?: "start" | "end";
  /** Disable the outside-click close for composite surfaces. */
  readonly width?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        ref.current !== null &&
        !ref.current.contains(target) &&
        (props.anchor === null || !props.anchor.contains(target))
      ) {
        props.onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        props.onClose();
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [props.open, props.onClose, props.anchor]);

  useLayoutEffect(() => {
    if (!props.open) return;
    const anchor = props.anchor;
    const node = ref.current;
    if (anchor === null || node === null) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    let left = props.align === "end" ? rect.right - node.offsetWidth : rect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - node.offsetWidth - margin));
    const top = Math.min(rect.bottom + 6, window.innerHeight - node.offsetHeight - margin);
    node.style.top = `${top}px`;
    node.style.left = `${left}px`;
  });

  if (!props.open) return null;
  const style: CSSProperties = props.width === undefined ? {} : { width: props.width };
  return createPortal(
    <div ref={ref} className="pcms-popover" style={style}>
      {props.children}
    </div>,
    document.body,
  );
}
