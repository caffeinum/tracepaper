import type { Comment, Frame } from "./types.ts";

/** Frames travel over the bus without their html — SSE clients refetch `/f/:id`. */
export type FramePayload = Omit<Frame, "html">;

export type BusEvent =
  | { type: "frame.created"; frame: FramePayload }
  | { type: "frame.updated"; frame: FramePayload }
  | { type: "frame.deleted"; frame: FramePayload }
  | { type: "comment.created"; comment: Comment }
  | { type: "comment.updated"; comment: Comment }
  | { type: "comment.deleted"; comment: Comment };

export type BusListener = (event: BusEvent) => void;

export function toFramePayload(frame: Frame): FramePayload {
  const { html: _html, ...rest } = frame;
  return rest;
}

export class Bus {
  #listeners = new Set<BusListener>();

  emit(event: BusEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        // One broken subscriber must not silence the rest.
        console.error(`[bus] listener threw on ${event.type}:`, error);
      }
    }
  }

  subscribe(listener: BusListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}
