/**
 * Plain callback registry for hash/key highlighting.
 * No React state — components register their own setState callbacks.
 */
export class HighlightRegistry {
  private listeners = new Map<string, Set<(highlighted: boolean) => void>>();
  private current = new Set<string>();

  /** Register a callback for a key. Returns an unregister function. */
  register(key: string, cb: (highlighted: boolean) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);

    // Immediately notify if already highlighted
    if (this.current.has(key)) {
      cb(true);
    }

    return () => {
      set!.delete(cb);
      if (set!.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  /** Set which keys are hovered. Diff prev/next, notify only changed. */
  setHovered(keys: string[]): void {
    const next = new Set(keys);

    // Unhighlight keys that were current but not in next
    for (const key of this.current) {
      if (!next.has(key)) {
        const set = this.listeners.get(key);
        if (set) {
          for (const cb of set) cb(false);
        }
      }
    }

    // Highlight keys that are in next but not current
    for (const key of next) {
      if (!this.current.has(key)) {
        const set = this.listeners.get(key);
        if (set) {
          for (const cb of set) cb(true);
        }
      }
    }

    this.current = next;
  }
}
