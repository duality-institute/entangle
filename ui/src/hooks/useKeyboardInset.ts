import { useEffect } from "react";

const KEYBOARD_INSET_PROPERTY = "--keyboard-inset";

export interface KeyboardViewportLike {
  height: number;
  offsetTop: number;
  scale: number;
}

export function keyboardInset(
  viewport: KeyboardViewportLike | undefined,
  layoutHeight: number,
  editorFocused: boolean,
): number {
  if (!viewport || !editorFocused || Math.abs(viewport.scale - 1) > 0.01) return 0;
  const offsetTop = Math.max(0, viewport.offsetTop);
  return Math.max(0, Math.round(layoutHeight - viewport.height - offsetTop));
}

function composerEditorFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement
    && active.classList.contains("composer__input")
    && !active.disabled
    && !active.readOnly;
}

/**
 * Reserves the part of the layout viewport that is still covered after the
 * browser has resized or panned its visual viewport. The app shell consumes
 * this once as bottom padding; its focused textarea never enters a fixed or
 * script-resized ancestor.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = 0;

    const apply = (): void => {
      frame = 0;
      const inset = keyboardInset(viewport ?? undefined, window.innerHeight, composerEditorFocused());
      root.style.setProperty(KEYBOARD_INSET_PROPERTY, `${inset}px`);
    };

    const schedule = (): void => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(apply);
      }
    };

    apply();

    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      root.style.removeProperty(KEYBOARD_INSET_PROPERTY);
    };
  }, []);
}
