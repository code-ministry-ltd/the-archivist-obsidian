
// When to sync (spec 0005 §5.1): about 2 minutes after the last change, on a backstop timer,
// and on request. Only one sync runs at a time; a change during a sync schedules another.

export const SETTLE_MS = 2 * 60 * 1000;

export class Scheduler {
  private settleTimer: number | null = null;
  private backstopTimer: number | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly run: () => Promise<void>,
    private readonly settleMs = SETTLE_MS,
  ) {}

  /** A note was created, changed, renamed or deleted. */
  changed(): void {
    if (this.settleTimer) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      void this.now();
    }, this.settleMs);
  }

  /** Every `minutes`, or never for 0. */
  setBackstop(minutes: number): void {
    if (this.backstopTimer) window.clearInterval(this.backstopTimer);
    this.backstopTimer = minutes > 0 ? window.setInterval(() => void this.now(), minutes * 60 * 1000) : null;
  }

  /** Syncs now, or right after the sync already running. */
  now(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.run();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  stop(): void {
    if (this.settleTimer) window.clearTimeout(this.settleTimer);
    if (this.backstopTimer) window.clearInterval(this.backstopTimer);
    this.settleTimer = null;
    this.backstopTimer = null;
  }
}
