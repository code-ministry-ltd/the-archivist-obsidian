// Which files a root may hold, and the exclude patterns, matching The Archivist's server and
// command-line tool (spec 0001 §5.2, §5.7), so the plugin never sends what the server refuses.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MANIFEST_PAGE_SIZE = 5000;

const ROOT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A root name: lower-case letters, digits, dots, dashes and underscores. */
export function isValidRoot(root: string): boolean {
  return ROOT_NAME.test(root);
}

/** The default root for a vault: `obsidian-` and its name, as a valid root name. */
export function defaultRoot(vaultName: string): string {
  const slug = vaultName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return `obsidian-${slug || "vault"}`.slice(0, 64).replace(/[-._]+$/, "");
}

/** A relative POSIX path to a `.md` file with no hidden, empty, `.` or `..` segments. */
export function isSyncablePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\\]/.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s.startsWith("."))) return false;
  return path.toLowerCase().endsWith(".md");
}

function patternRegex(pattern: string): RegExp {
  const trimmed = pattern.trim().replace(/^\/+|\/+$/g, "");
  let source = "";
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (c === "*" && trimmed[i + 1] === "*") {
      // `**/` matches any number of folders, including none; a bare `**` matches anything.
      if (trimmed[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i++;
      }
    } else if (c === "*") source += "[^/]*";
    else source += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern names a file or a folder: a folder excludes everything under it.
  return new RegExp(`^${source}(?:/.*)?$`);
}

/** A predicate that's true for paths any of the patterns exclude. Empty patterns are ignored. */
export function excluder(patterns: readonly string[]): (path: string) => boolean {
  const regexes = patterns.filter((p) => p.trim().replace(/\//g, "") !== "").map(patternRegex);
  return (path) => regexes.some((r) => r.test(path));
}

/**
 * The deletion guard (spec 0005 §5.3): a sync that would remove more than 20 notes and more
 * than a quarter of the root stops and asks first.
 */
export function needsDeletionConfirmation(deleteCount: number, keptCount: number): boolean {
  return deleteCount > 20 && deleteCount > (deleteCount + keptCount) / 4;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
