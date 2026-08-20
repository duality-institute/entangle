import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import "../styles/controls.css";

interface PickerModalBaseProps {
  open: boolean;
  title: string;
  testId: string;
  children: ReactNode;
}

type PickerModalProps = PickerModalBaseProps & (
  | { dismissable?: true; onClose: () => void }
  | { dismissable: false; onClose?: never }
);

export default function PickerModal({
  open,
  title,
  dismissable = true,
  onClose,
  testId,
  children,
}: PickerModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const target = dialog?.querySelector<HTMLElement>('[aria-checked="true"]') ?? dialog;
    target?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (dismissable && event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [dismissable, open, onClose]);

  if (!open) return null;

  const modal = (
    <div className="picker-modal-layer">
      {dismissable ? (
        <button
          type="button"
          className="picker-modal__backdrop"
          aria-label={`Close ${title}`}
          onClick={onClose}
        />
      ) : (
        <div className="picker-modal__backdrop" aria-hidden="true" />
      )}
      <div
        ref={dialogRef}
        className="picker-modal"
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="picker-modal__header">
          <h2 id={titleId} className="picker-modal__title">{title}</h2>
          {dismissable ? (
            <button type="button" className="picker-modal__close" onClick={onClose}>Close</button>
          ) : null}
        </header>
        {children}
      </div>
    </div>
  );

  return typeof document === "undefined" ? modal : createPortal(modal, document.body);
}

export function CheckMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m5 12.5 4.6 4.5L19 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Caret() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m7 10 5 5 5-5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
