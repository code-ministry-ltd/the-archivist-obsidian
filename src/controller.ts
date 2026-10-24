import { ApiError, createApi, OfflineError, type Transport } from "./api.ts";
import type { HashCache, VaultLike } from "./files.ts";
import { ImportFailedError, type SyncOutcome, type SyncProgress, syncVault } from "./sync.ts";

// What a sync means for the person (spec 0005 §5, §6): it runs the sync, turns outcomes and
// errors into a state and a sentence, and forgets a token the archive no longer accepts.
// No Obsidian imports, so it's tested in plain Node.

export type SyncState =
  | { kind: "disconnected"; reason?: string }
  | { kind: "idle" }
  | { kind: "syncing"; progress?: SyncProgress }
  | { kind: "attention"; message: string }
  | { kind: "waiting"; deleteCount: number };

export interface LastSync {
  at: string;
  uploaded: number;
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
  tooLarge: string[];
}

export interface Host {
  vault: VaultLike;
  transport: Transport;
  baseUrl(): string;
  root(): string;
  excludes(): readonly string[];
  attachmentFolder(): string | null;
  configDir(): string;
  token(): string | null;
  setToken(token: string | null): void;
  loadCache(): HashCache;
  saveCache(cache: HashCache): void;
  /** Asks before removing many notes; true to go ahead (§5.3). */
  confirmDeletion(count: number): Promise<boolean>;
  onState(state: SyncState): void;
  onSynced(last: LastSync): void;
}

const RETRY_MINUTES = [1, 2, 5, 15];

export class SyncController {
  state: SyncState;
  /** After "Not now" on a large deletion, wait for the next change (§5.3). */
  private heldUntilChange = false;
  private failures = 0;
  private retryTimer: number | null = null;

  constructor(
    private readonly host: Host,
    private readonly retry: () => void,
  ) {
    this.state = host.token() ? { kind: "idle" } : { kind: "disconnected" };
  }

  private set(state: SyncState) {
    this.state = state;
    this.host.onState(state);
  }

  /** A note changed: a held sync may run again. */
  changed(): void {
    this.heldUntilChange = false;
  }

  async sync(): Promise<void> {
    const token = this.host.token();
    if (!token) return this.set({ kind: "disconnected" });
    if (this.heldUntilChange) return;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const api = createApi(this.host.baseUrl(), token, this.host.transport);
    const options = {
      api,
      vault: this.host.vault,
      root: this.host.root(),
      excludes: this.host.excludes(),
      attachmentFolder: this.host.attachmentFolder(),
      configDir: this.host.configDir(),
      cache: this.host.loadCache(),
      onProgress: (progress: SyncProgress) => this.set({ kind: "syncing", progress }),
    };
    this.set({ kind: "syncing" });
    try {
      let outcome: SyncOutcome = await syncVault(options);
      if (outcome.status === "needs-confirmation") {
        this.host.saveCache(outcome.cache);
        this.set({ kind: "waiting", deleteCount: outcome.deleteCount });
        if (!(await this.host.confirmDeletion(outcome.deleteCount))) {
          this.heldUntilChange = true;
          return;
        }
        this.set({ kind: "syncing" });
        outcome = await syncVault({ ...options, cache: outcome.cache, allowLargeDeletion: true });
      }
      if (outcome.status === "empty") {
        return this.set({
          kind: "attention",
          message: "There are no notes to sync, so nothing was sent.",
        });
      }
      if (outcome.status !== "synced") return;
      this.host.saveCache(outcome.cache);
      this.failures = 0;
      const { record } = outcome;
      this.host.onSynced({
        at: new Date().toISOString(),
        uploaded: outcome.uploaded,
        added: record.added,
        updated: record.updated,
        deleted: record.deleted,
        skipped: record.skipped,
        tooLarge: outcome.tooLarge,
      });
      this.set({ kind: "idle" });
    } catch (err) {
      this.failed(err);
    }
  }

  private failed(err: unknown) {
    if (err instanceof ApiError && (err.status === 401 || err.code === "wrong_root")) {
      // Revoked in Settings, replaced by another device, or the root was renamed: connect again.
      this.host.setToken(null);
      return this.set({
        kind: "disconnected",
        reason:
          err.code === "wrong_root"
            ? "This vault's folder name changed. Connect again to sync it."
            : "The archive no longer accepts this device. It may have been disconnected in Settings, or another device now syncs this vault.",
      });
    }
    let message: string;
    let retry = true;
    if (err instanceof OfflineError) message = "Can't reach the archive. Will try again.";
    else if (err instanceof ApiError && err.code === "archive_full") {
      message = "Your archive is full, so new notes aren't being added.";
      retry = false;
    } else if (err instanceof ApiError && err.status === 429) message = "The archive is busy. Will try again.";
    else if (err instanceof ImportFailedError) message = `The import failed (${err.message}). Will try again.`;
    else if (err instanceof ApiError) message = `${err.message} Will try again.`;
    else message = `Sync stopped: ${err instanceof Error ? err.message : String(err)}`;
    this.set({ kind: "attention", message });
    if (retry) {
      const minutes = RETRY_MINUTES[Math.min(this.failures, RETRY_MINUTES.length - 1)]!;
      this.failures++;
      this.retryTimer = window.setTimeout(() => this.retry(), minutes * 60 * 1000);
    }
  }

  stop(): void {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
  }
}
