import type { Api } from "./api.ts";
import { buildManifest, type HashCache, type VaultLike } from "./files.ts";
import { MANIFEST_PAGE_SIZE, needsDeletionConfirmation } from "./rules.ts";

// One sync of the vault as a root, over the sync protocol (spec 0001 §5.5, spec 0005 §5.2):
// manifest pages, then the uploads the server asks for, then commit.

interface ManifestResult {
  upload: string[];
  tooLarge: string[];
  unchanged: number;
  deleteCount: number;
}

export interface ImportRecord {
  status: "queued" | "running" | "finished" | "failed";
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
  total: number;
  error: string | null;
}

export interface SyncOptions {
  api: Api;
  vault: VaultLike;
  root: string;
  excludes: readonly string[];
  attachmentFolder?: string | null;
  configDir: string;
  cache: HashCache;
  /** Set once the person has agreed to a large deletion (§5.3). */
  allowLargeDeletion?: boolean;
  onProgress?: (p: SyncProgress) => void;
  pageSize?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type SyncProgress =
  | { stage: "comparing" }
  | { stage: "uploading"; done: number; total: number }
  | { stage: "importing"; record: ImportRecord };

export type SyncOutcome =
  | {
      status: "synced";
      uploaded: number;
      unchanged: number;
      record: ImportRecord;
      tooLarge: string[];
      unsyncable: string[];
      cache: HashCache;
    }
  /** Stopped before anything changed: this sync would remove many notes (§5.3). */
  | { status: "needs-confirmation"; deleteCount: number; cache: HashCache }
  /** Nothing to send: an empty vault, or one still loading, would empty the root. */
  | { status: "empty" };

export class ImportFailedError extends Error {}

export const UPLOAD_CONCURRENCY = 3;

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

export async function syncVault(options: SyncOptions): Promise<SyncOutcome> {
  const { api, root } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)));
  options.onProgress?.({ stage: "comparing" });
  const manifest = await buildManifest(options.vault, {
    excludes: options.excludes,
    attachmentFolder: options.attachmentFolder,
    configDir: options.configDir,
    cache: options.cache,
  });
  // A full manifest with nothing in it would delete every note in the root.
  if (manifest.entries.length === 0) return { status: "empty" };

  const pageSize = options.pageSize ?? MANIFEST_PAGE_SIZE;
  const pages = Math.ceil(manifest.entries.length / pageSize);
  const upload: string[] = [];
  const tooLarge = [...manifest.tooLarge];
  let unchanged = 0;
  let deleteCount = 0;
  for (let page = 0; page < pages; page++) {
    const result = await api.post<ManifestResult>("/api/sync/manifest", {
      root,
      source: "note",
      full: true,
      page,
      last: page === pages - 1,
      entries: manifest.entries.slice(page * pageSize, (page + 1) * pageSize),
    });
    upload.push(...result.upload);
    tooLarge.push(...result.tooLarge);
    unchanged += result.unchanged;
    deleteCount = result.deleteCount;
  }

  if (!options.allowLargeDeletion && needsDeletionConfirmation(deleteCount, manifest.entries.length)) {
    return { status: "needs-confirmation", deleteCount, cache: manifest.cache };
  }

  let uploaded = 0;
  options.onProgress?.({ stage: "uploading", done: 0, total: upload.length });
  await eachLimit(upload, UPLOAD_CONCURRENCY, async (path) => {
    const bytes = await options.vault.readBinary(path);
    const query = new URLSearchParams({ root, path });
    await api.put(`/api/sync/files?${query}`, bytes);
    uploaded++;
    options.onProgress?.({ stage: "uploading", done: uploaded, total: upload.length });
  });

  const { importId } = await api.post<{ importId: string }>("/api/sync/commit", { root });
  let record: ImportRecord;
  for (;;) {
    record = await api.get<ImportRecord>(`/api/imports/${encodeURIComponent(importId)}`);
    options.onProgress?.({ stage: "importing", record });
    if (record.status === "finished" || record.status === "failed") break;
    await sleep(options.pollMs ?? 3000);
  }
  if (record.status === "failed") {
    throw new ImportFailedError(record.error ?? "The import failed.");
  }
  return {
    status: "synced",
    uploaded,
    unchanged,
    record,
    tooLarge,
    unsyncable: manifest.unsyncable,
    cache: manifest.cache,
  };
}
