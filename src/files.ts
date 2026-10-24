import { excluder, isSyncablePath, MAX_FILE_BYTES, sha256Hex } from "./rules.ts";

// The vault's side of a sync (spec 0005 §4): which notes to send, and their hashes.

export interface VaultFile {
  path: string;
  size: number;
  mtime: number;
}

/** The little of Obsidian's vault this needs, so it can be tested without Obsidian. */
export interface VaultLike {
  markdownFiles(): VaultFile[];
  readBinary(path: string): Promise<ArrayBuffer>;
}

export interface CachedHash {
  mtime: number;
  size: number;
  hash: string;
}

/** Device-local `path → {mtime, size, hash}`, so only changed notes are read again. */
export type HashCache = Record<string, CachedHash>;

export interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
}

export interface VaultManifest {
  entries: ManifestEntry[];
  /** Notes over 10 MB, which aren't sent. */
  tooLarge: string[];
  /** Notes whose names the archive can't store (hidden folders, control characters). */
  unsyncable: string[];
  excluded: number;
  /** The cache to keep for next time: only the notes in this manifest. */
  cache: HashCache;
  /** How many notes were read and hashed this time. */
  hashed: number;
}

export interface ManifestOptions {
  excludes: readonly string[];
  /** Obsidian's attachment folder, when it's a real folder, is left out (§4.2). */
  attachmentFolder?: string | null;
  /** Obsidian's settings folder, usually `.obsidian`; always left out. */
  configDir: string;
  cache: HashCache;
}


export async function buildManifest(vault: VaultLike, options: ManifestOptions): Promise<VaultManifest> {
  const patterns = [options.configDir, ".trash", ...options.excludes];
  const folder = options.attachmentFolder?.replace(/^\.?\/+|\/+$/g, "");
  if (folder) patterns.push(folder);
  const excluded = excluder(patterns);

  const result: VaultManifest = {
    entries: [],
    tooLarge: [],
    unsyncable: [],
    excluded: 0,
    cache: {},
    hashed: 0,
  };
  const files = vault.markdownFiles().sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const file of files) {
    if (excluded(file.path)) {
      result.excluded++;
      continue;
    }
    if (!isSyncablePath(file.path)) {
      result.unsyncable.push(file.path);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      result.tooLarge.push(file.path);
      continue;
    }
    const cached = options.cache[file.path];
    let hash: string;
    let size = file.size;
    if (cached && cached.mtime === file.mtime && cached.size === file.size) {
      hash = cached.hash;
    } else {
      const bytes = await vault.readBinary(file.path);
      size = bytes.byteLength;
      if (size > MAX_FILE_BYTES) {
        result.tooLarge.push(file.path);
        continue;
      }
      hash = await sha256Hex(bytes);
      result.hashed++;
    }
    result.entries.push({ path: file.path, hash, size });
    result.cache[file.path] = { mtime: file.mtime, size, hash };
  }
  return result;
}
