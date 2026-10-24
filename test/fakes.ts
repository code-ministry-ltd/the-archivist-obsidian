import type { Transport } from "../src/api.ts";
import type { VaultFile, VaultLike } from "../src/files.ts";
import { sha256Hex } from "../src/rules.ts";

/** A vault in memory: path → text, with mtimes that change on write. */
export class FakeVault implements VaultLike {
  files = new Map<string, { bytes: Uint8Array; mtime: number; size?: number }>();
  reads: string[] = [];
  private clock = 1;

  write(path: string, text: string, size?: number) {
    this.files.set(path, { bytes: new TextEncoder().encode(text), mtime: this.clock++, size });
    return this;
  }

  remove(path: string) {
    this.files.delete(path);
  }

  markdownFiles(): VaultFile[] {
    return [...this.files]
      .filter(([path]) => path.endsWith(".md"))
      .map(([path, f]) => ({ path, mtime: f.mtime, size: f.size ?? f.bytes.byteLength }));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.reads.push(path);
    const f = this.files.get(path);
    if (!f) throw new Error("missing");
    return f.bytes.slice().buffer;
  }
}

/** Just enough of the archive's sync protocol and device sign-in. */
export class FakeArchive {
  stored = new Map<string, string>(); // path → hash, for one root
  staged = new Map<string, string>();
  manifest: { path: string; hash: string }[] = [];
  tokens = new Set(["arch_good"]);
  requests: { method: string; path: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  deviceAnswers: { status: string; token?: string }[] = [];

  transport: Transport = async (req) => {
    const url = new URL(req.url);
    this.requests.push({ method: req.method, path: url.pathname });
    const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });
    if (url.pathname === "/api/device/start") {
      return json(200, {
        deviceCode: "dc",
        userCode: "KDWF-QRMT",
        verificationUrl: "https://archive.test/connect?code=KDWF-QRMT",
        interval: 8,
        expiresIn: 600,
      });
    }
    if (url.pathname === "/api/device/token") return json(200, this.deviceAnswers.shift() ?? { status: "pending" });
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token || !this.tokens.has(token)) {
      return json(401, { error: { code: "invalid_token", message: "This access token isn't valid." } });
    }
    if (url.pathname === "/api/sync/manifest") {
      const body = JSON.parse(typeof req.body === "string" ? req.body : "{}") as {
        page: number;
        last: boolean;
        entries: { path: string; hash: string }[];
      };
      if (body.page === 0) this.manifest = [];
      this.manifest.push(...body.entries);
      const upload = body.entries.filter((e) => this.stored.get(e.path) !== e.hash).map((e) => e.path);
      const kept = new Set(this.manifest.map((e) => e.path));
      const deleteCount = [...this.stored.keys()].filter((p) => !kept.has(p)).length;
      return json(200, {
        upload,
        tooLarge: [],
        unchanged: body.entries.length - upload.length,
        deleteCount: body.last ? deleteCount : 0,
      });
    }
    if (url.pathname === "/api/sync/files") {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      await new Promise((r) => setTimeout(r, 1));
      this.inFlight--;
      const path = url.searchParams.get("path")!;
      this.staged.set(path, await sha256Hex(req.body as ArrayBuffer));
      return json(200, { path });
    }
    if (url.pathname === "/api/sync/commit") {
      const kept = new Map(this.manifest.map((e) => [e.path, e.hash]));
      let added = 0;
      let updated = 0;
      let deleted = 0;
      for (const path of [...this.stored.keys()]) {
        if (!kept.has(path)) {
          this.stored.delete(path);
          deleted++;
        }
      }
      for (const [path, hash] of this.staged) {
        if (this.stored.has(path)) updated++;
        else added++;
        this.stored.set(path, hash);
      }
      this.staged.clear();
      this.last = { added, updated, deleted };
      return json(202, { importId: "imp1" });
    }
    if (url.pathname.startsWith("/api/imports/")) {
      return json(200, { status: "finished", ...this.last, skipped: 0, total: this.manifest.length, error: null });
    }
    if (url.pathname === "/api/tokens/current") {
      this.tokens.delete(token);
      return json(200, { ok: true });
    }
    return json(404, { error: { code: "not_found", message: "nope" } });
  };

  private last = { added: 0, updated: 0, deleted: 0 };
}
