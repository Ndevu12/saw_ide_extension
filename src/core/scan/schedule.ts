export type Job = (signal: AbortSignal) => Promise<void>;

interface Slot {
  timer: ReturnType<typeof setTimeout> | undefined;
  running: AbortController | undefined;
  /** A request arrived while a run was in progress; run once more when it ends. */
  again: boolean;
}

/**
 * Runs at most one job per key at a time. Requests inside the debounce window collapse into one
 * run, and a request during a run schedules exactly one follow-up, so the last change is always scanned.
 */
export class Scheduler {
  private readonly slots = new Map<string, Slot>();
  private disposed = false;

  constructor(
    private readonly job: (key: string, signal: AbortSignal) => Promise<void>,
    private readonly debounceMs: number,
  ) {}

  request(key: string, options: { immediate?: boolean } = {}): void {
    if (this.disposed) {
      return;
    }
    const slot = this.slot(key);
    if (slot.running) {
      slot.again = true;
      return;
    }
    if (slot.timer) {
      clearTimeout(slot.timer);
    }
    slot.timer = setTimeout(() => this.start(key), options.immediate ? 0 : this.debounceMs);
  }

  /** Stop any run for `key` and forget it, e.g. when a folder leaves the workspace. */
  cancel(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) {
      return;
    }
    if (slot.timer) {
      clearTimeout(slot.timer);
    }
    slot.again = false;
    slot.running?.abort();
    this.slots.delete(key);
  }

  isBusy(key: string): boolean {
    const slot = this.slots.get(key);
    return Boolean(slot?.running || slot?.timer);
  }

  dispose(): void {
    this.disposed = true;
    for (const key of [...this.slots.keys()]) {
      this.cancel(key);
    }
  }

  private slot(key: string): Slot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { timer: undefined, running: undefined, again: false };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private start(key: string): void {
    const slot = this.slots.get(key);
    if (!slot || this.disposed) {
      return;
    }
    slot.timer = undefined;
    const controller = new AbortController();
    slot.running = controller;
    void this.job(key, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.slots.get(key) !== slot) {
          return;
        }
        slot.running = undefined;
        if (slot.again && !this.disposed) {
          slot.again = false;
          this.request(key);
        }
      });
  }
}
