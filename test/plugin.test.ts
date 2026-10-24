import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api.ts";
import { startConnecting, waitForApproval } from "../src/connect.ts";
import { type Host, type SyncState, SyncController } from "../src/controller.ts";
import { buildManifest, type HashCache } from "../src/files.ts";
import { defaultRoot, excluder, MAX_FILE_BYTES } from "../src/rules.ts";
import { Scheduler } from "../src/scheduler.ts";
import { syncVault, UPLOAD_CONCURRENCY } from "../src/sync.ts";
import { FakeArchive, FakeVault } from "./fakes.ts";

const api = (archive: FakeArchive, token = "arch_good") =>
  createApi("https://archive.test", token, archive.transport);

const noSleep = async () => {};

describe("the vault's manifest", () => {
  it("leaves out .obsidian, .trash, the attachment folder, excluded folders and files over 10 MB", async () => {
    const vault = new FakeVault()
      .write("Garden/Compost.md", "# Compost")
      .write(".obsidian/workspace.md", "x")
      .write(".trash/old.md", "x")
      .write("Attachments/drawing.md", "x")
      .write("Private/diary.md", "x")
      .write("Journal/2024/drafts/a.md", "x")
      .write("Big.md", "x", MAX_FILE_BYTES + 1)
      .write("Garden/photo.png", "x");
    const m = await buildManifest(vault, {
      excludes: ["Private", "Journal/**/drafts"],
      attachmentFolder: "Attachments",
      configDir: ".obsidian",
      cache: {},
    });
    expect(m.entries.map((e) => e.path)).toEqual(["Garden/Compost.md"]);
    expect(m.tooLarge).toEqual(["Big.md"]);
    expect(m.excluded).toBe(5);
    expect(vault.reads).toEqual(["Garden/Compost.md"]);
  });

  it("reads again only the notes whose size or modified time changed", async () => {
    const vault = new FakeVault().write("a.md", "one").write("b.md", "two");
    const first = await buildManifest(vault, { excludes: [], configDir: ".obsidian", cache: {} });
    expect(first.hashed).toBe(2);
    vault.reads = [];
    vault.write("b.md", "two, edited");
    const second = await buildManifest(vault, { excludes: [], configDir: ".obsidian", cache: first.cache });
    expect(second.hashed).toBe(1);
    expect(vault.reads).toEqual(["b.md"]);
    expect(second.entries.find((e) => e.path === "a.md")!.hash).toBe(
      first.entries.find((e) => e.path === "a.md")!.hash,
    );
  });

  it("matches folder patterns the way the command-line tool does", () => {
    const out = excluder(["AI Skills", "**/tmp"]);
    expect(out("AI Skills/x.md")).toBe(true);
    expect(out("deep/a/tmp/x.md")).toBe(true);
    expect(out("AI Skillsets/x.md")).toBe(false);
  });

  it("names a vault's default folder from its name", () => {
    expect(defaultRoot("Personal")).toBe("obsidian-personal");
    expect(defaultRoot("Jim's Vault (2026)")).toBe("obsidian-jim-s-vault-2026");
    expect(defaultRoot("Café notes")).toBe("obsidian-cafe-notes");
  });
});

describe("syncing", () => {
  it("uploads only new and changed notes, at most three at a time, and commits", async () => {
    const archive = new FakeArchive();
    const vault = new FakeVault();
    for (let i = 0; i < 10; i++) vault.write(`n${i}.md`, `note ${i}`);
    const first = await syncVault({ api: api(archive), vault, root: "obsidian-test", excludes: [], configDir: ".obsidian", cache: {}, sleep: noSleep });
    expect(first).toMatchObject({ status: "synced", uploaded: 10, record: { added: 10 } });
    expect(archive.maxInFlight).toBeLessThanOrEqual(UPLOAD_CONCURRENCY);
    expect(archive.maxInFlight).toBeGreaterThan(1);

    vault.write("n3.md", "note 3, edited");
    const cache = first.status === "synced" ? first.cache : {};
    const second = await syncVault({ api: api(archive), vault, root: "obsidian-test", excludes: [], configDir: ".obsidian", cache, sleep: noSleep });
    expect(second).toMatchObject({ status: "synced", uploaded: 1, unchanged: 9, record: { updated: 1 } });
  });

  it("stops before removing more than a quarter of the root, and goes ahead once allowed", async () => {
    const archive = new FakeArchive();
    const vault = new FakeVault();
    for (let i = 0; i < 100; i++) vault.write(`n${i}.md`, `note ${i}`);
    await syncVault({ api: api(archive), vault, root: "r", excludes: [], configDir: ".obsidian", cache: {}, sleep: noSleep });
    for (let i = 0; i < 30; i++) vault.remove(`n${i}.md`);
    const stopped = await syncVault({ api: api(archive), vault, root: "r", excludes: [], configDir: ".obsidian", cache: {}, sleep: noSleep });
    expect(stopped).toMatchObject({ status: "needs-confirmation", deleteCount: 30 });
    expect(archive.requests.filter((r) => r.path === "/api/sync/commit")).toHaveLength(1);
    expect(archive.stored.size).toBe(100);

    const allowed = await syncVault({
      api: api(archive),
      vault,
      root: "r",
      excludes: [],
      configDir: ".obsidian",
      cache: {},
      allowLargeDeletion: true,
      sleep: noSleep,
    });
    expect(allowed).toMatchObject({ status: "synced", record: { deleted: 30 } });
  });

  it("removes a handful of deleted notes without asking", async () => {
    const archive = new FakeArchive();
    const vault = new FakeVault();
    for (let i = 0; i < 100; i++) vault.write(`n${i}.md`, `note ${i}`);
    await syncVault({ api: api(archive), vault, root: "r", excludes: [], configDir: ".obsidian", cache: {}, sleep: noSleep });
    for (let i = 0; i < 20; i++) vault.remove(`n${i}.md`);
    const res = await syncVault({ api: api(archive), vault, root: "r", excludes: [], configDir: ".obsidian", cache: {}, sleep: noSleep });
    expect(res).toMatchObject({ status: "synced", record: { deleted: 20 } });
  });

  it("sends nothing for an empty vault, which would otherwise empty the root", async () => {
    const archive = new FakeArchive();
    const res = await syncVault({ api: api(archive), vault: new FakeVault(), root: "r", excludes: [], configDir: ".obsidian", cache: {} });
    expect(res).toEqual({ status: "empty" });
    expect(archive.requests).toEqual([]);
  });
});

describe("the sync schedule", () => {
  it("makes one sync of a burst of changes, after they settle", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => {});
      const scheduler = new Scheduler(run, 120_000);
      for (let i = 0; i < 25; i++) {
        scheduler.changed();
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs one more sync when asked during a sync, never two at once", async () => {
    let release!: () => void;
    let running = 0;
    let most = 0;
    const run = vi.fn(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((r) => (release = r));
      running--;
    });
    const scheduler = new Scheduler(run);
    const first = scheduler.now();
    void scheduler.now();
    void scheduler.now();
    release();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });
});

function host(archive: FakeArchive, vault: FakeVault, overrides: Partial<Host> = {}) {
  let token: string | null = "arch_good";
  let cache: HashCache = {};
  const states: SyncState[] = [];
  const h: Host = {
    vault,
    transport: archive.transport,
    baseUrl: () => "https://archive.test",
    root: () => "obsidian-test",
    excludes: () => [],
    attachmentFolder: () => null,
    configDir: () => ".obsidian",
    token: () => token,
    setToken: (t) => (token = t),
    loadCache: () => cache,
    saveCache: (c) => (cache = c),
    confirmDeletion: async () => false,
    onState: (s) => states.push(s),
    onSynced: () => {},
    ...overrides,
  };
  return { h, states, token: () => token };
}

describe("the plugin's state", () => {
  it("forgets a revoked token and shows Connect again", async () => {
    const archive = new FakeArchive();
    const vault = new FakeVault().write("a.md", "# A");
    const { h, token } = host(archive, vault);
    const controller = new SyncController(h, () => {});
    await controller.sync();
    expect(controller.state).toEqual({ kind: "idle" });

    archive.tokens.clear();
    vault.write("a.md", "# A, edited");
    await controller.sync();
    expect(token()).toBeNull();
    expect(controller.state.kind).toBe("disconnected");
    controller.stop();
  });

  it("holds a large deletion after Not now until the vault changes", async () => {
    const archive = new FakeArchive();
    const vault = new FakeVault();
    for (let i = 0; i < 40; i++) vault.write(`n${i}.md`, `note ${i}`);
    const confirm = vi.fn(async () => false);
    const { h } = host(archive, vault, { confirmDeletion: confirm });
    const controller = new SyncController(h, () => {});
    await controller.sync();
    for (let i = 0; i < 30; i++) vault.remove(`n${i}.md`);
    await controller.sync();
    expect(confirm).toHaveBeenCalledWith(30);
    expect(archive.stored.size).toBe(40);
    await controller.sync();
    expect(confirm).toHaveBeenCalledTimes(1);
    controller.changed();
    await controller.sync();
    expect(confirm).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("asks to retry later when the archive can't be reached", async () => {
    vi.useFakeTimers();
    try {
      const vault = new FakeVault().write("a.md", "# A");
      const retry = vi.fn();
      const { h } = host(new FakeArchive(), vault, {
        transport: async () => {
          throw new Error("offline");
        },
      });
      const controller = new SyncController(h, retry);
      await controller.sync();
      expect(controller.state).toEqual({ kind: "attention", message: "Can't reach the archive. Will try again." });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(retry).toHaveBeenCalledTimes(1);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("connecting", () => {
  it("polls until the request is approved and returns the token", async () => {
    const archive = new FakeArchive();
    archive.deviceAnswers = [{ status: "pending" }, { status: "pending" }, { status: "approved", token: "arch_new" }];
    const client = createApi("https://archive.test", null, archive.transport);
    const start = await startConnecting(client, "Mac, Personal", "obsidian-personal");
    expect(start.userCode).toBe("KDWF-QRMT");
    const sleeps: number[] = [];
    const outcome = await waitForApproval(client, start, {
      sleep: async (ms) => void sleeps.push(ms),
      cancelled: () => false,
    });
    expect(outcome).toEqual({ status: "approved", token: "arch_new" });
    expect(sleeps).toEqual([8000, 8000, 8000]);
  });

  it("stops when declined or cancelled", async () => {
    const archive = new FakeArchive();
    const client = createApi("https://archive.test", null, archive.transport);
    const start = await startConnecting(client, "Mac", "obsidian-personal");
    archive.deviceAnswers = [{ status: "declined" }];
    expect(await waitForApproval(client, start, { sleep: noSleep, cancelled: () => false })).toEqual({
      status: "declined",
    });
    expect(await waitForApproval(client, start, { sleep: noSleep, cancelled: () => true })).toEqual({
      status: "cancelled",
    });
  });
});
