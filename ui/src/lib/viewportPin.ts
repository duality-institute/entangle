export interface ViewportRepinnerOptions {
  isPinned: () => boolean;
  setRepinning: (active: boolean) => void;
  scrollToBottom: () => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frame: number) => void;
}

export interface ViewportRepinner {
  signal: () => void;
  stop: () => void;
}

export function createViewportRepinner({
  isPinned,
  setRepinning,
  scrollToBottom,
  requestFrame,
  cancelFrame,
}: ViewportRepinnerOptions): ViewportRepinner {
  let frame = 0;
  let framesRemaining = 0;

  const tick = (): void => {
    frame = 0;
    if (!isPinned()) {
      framesRemaining = 0;
      setRepinning(false);
      return;
    }

    scrollToBottom();
    framesRemaining -= 1;
    if (framesRemaining > 0) frame = requestFrame(tick);
    else setRepinning(false);
  };

  const signal = (): void => {
    if (!isPinned()) return;
    setRepinning(true);
    framesRemaining = 2;
    if (frame === 0) frame = requestFrame(tick);
  };

  const stop = (): void => {
    cancelFrame(frame);
    frame = 0;
    framesRemaining = 0;
    setRepinning(false);
  };

  return { signal, stop };
}
