/*
 * entangle — rAF-coalesced streaming text buffer
 * ------------------------------------------------------------------
 * A token stream fires far more often than the display can repaint (~80 tok/s
 * against a 60Hz screen, and bursts are much faster). Calling setState per
 * token means React reconciles and re-parses markdown dozens of times between
 * two frames, which is exactly how a phone drops into >50ms long tasks.
 *
 * Contract: `append()` is O(1) and touches NO React state — it mutates a ref
 * buffer keyed by partID. A SINGLE requestAnimationFrame loop, shared by every
 * part in flight, publishes the accumulated text at most once per frame.
 */

import { useEffect, useState } from "react";

export type StreamTexts = Readonly<Record<string, string>>;
type StreamListener = (texts: StreamTexts) => void;

interface StreamBuffer {
  append(partID: string, delta: string): void;
  set(partID: string, text: string): void;
  get(partID: string): string | undefined;
  clear(partID?: string): void;
  snapshot(): StreamTexts;
  subscribe(listener: StreamListener): () => void;
  /** Publishes synchronously; for tests and for end-of-turn settle. */
  flush(): void;
}

const schedule: (cb: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 16) as unknown as number;

const unschedule: (handle: number) => void =
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;

export function createStreamBuffer(): StreamBuffer {
  const pending = new Map<string, string>();
  const dirty = new Set<string>();
  const listeners = new Set<StreamListener>();
  let published: StreamTexts = {};
  let frame: number | null = null;

  function publish() {
    frame = null;
    if (dirty.size === 0) return;
    const next: Record<string, string> = { ...published };
    for (const id of dirty) {
      const text = pending.get(id);
      if (text === undefined) delete next[id];
      else next[id] = text;
    }
    dirty.clear();
    published = next;
    for (const listener of listeners) listener(published);
  }

  function markDirty(partID: string) {
    dirty.add(partID);
    if (frame === null) frame = schedule(publish);
  }

  return {
    append(partID, delta) {
      if (delta === "") return;
      pending.set(partID, (pending.get(partID) ?? "") + delta);
      markDirty(partID);
    },
    set(partID, text) {
      if (pending.get(partID) === text) return;
      pending.set(partID, text);
      markDirty(partID);
    },
    get(partID) {
      return pending.get(partID);
    },
    clear(partID) {
      if (partID === undefined) {
        for (const id of pending.keys()) dirty.add(id);
        pending.clear();
      } else {
        pending.delete(partID);
        dirty.add(partID);
      }
      if (frame === null) frame = schedule(publish);
    },
    snapshot() {
      return published;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && frame !== null) {
          unschedule(frame);
          frame = null;
        }
      };
    },
    flush() {
      if (frame !== null) {
        unschedule(frame);
        frame = null;
      }
      publish();
    },
  };
}

export function useStreamBuffer(buffer: StreamBuffer): StreamTexts {
  const [texts, setTexts] = useState<StreamTexts>(() => buffer.snapshot());
  useEffect(() => {
    setTexts(buffer.snapshot());
    return buffer.subscribe(setTexts);
  }, [buffer]);
  return texts;
}
