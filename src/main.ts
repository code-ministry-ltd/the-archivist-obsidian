import {
  type App,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  requestUrl,
} from "obsidian";
import { ApiError, createApi, type Transport } from "./api.ts";
import { type ConnectOutcome, startConnecting, waitForApproval } from "./connect.ts";
import { type LastSync, type SyncState, SyncController } from "./controller.ts";
import type { HashCache, VaultLike } from "./files.ts";
import { defaultRoot, isValidRoot } from "./rules.ts";
import { Scheduler } from "./scheduler.ts";

// The Archivist for Obsidian (spec 0005). Read-only towards the vault; the token lives in
// Obsidian's secret storage or device-local storage, never in data.json, which sits inside the
// vault and is often synced to other devices.

const DEFAULT_URL = "https://app.the-archivist.cc";

interface Settings {
  baseUrl: string;
  root: string;
  device: string;
  excludes: string[];
  intervalMinutes: number;
  lastSync: LastSync | null;
}

const transport: Transport = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    contentType: req.contentType,
    throw: false,
  });
  return { status: res.status, text: res.text };
};

function defaultDevice(vaultName: string): string {
  const kind = Platform.isIosApp
    ? "iPhone or iPad"
    : Platform.isAndroidApp
      ? "Android"
      : Platform.isMacOS
        ? "Mac"
        : Platform.isWin
          ? "Windows"
          : "Linux";
  return `${kind}, ${vaultName}`.slice(0, 60);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default class ArchivistPlugin extends Plugin {
  options!: Settings;
  controller!: SyncController;
  scheduler!: Scheduler;
  private statusBar: HTMLElement | null = null;
  private settingTab: ArchivistSettingTab | null = null;
  private connecting = false;

  async onload() {
    const vaultName = this.app.vault.getName();
    this.options = Object.assign(
      {
        baseUrl: DEFAULT_URL,
        root: defaultRoot(vaultName),
        device: defaultDevice(vaultName),
        excludes: [],
        intervalMinutes: 15,
        lastSync: null,
      } satisfies Settings,
      (await this.loadData()) as Partial<Settings> | null,
    );

    const vault: VaultLike = {
      markdownFiles: () =>
        this.app.vault
          .getMarkdownFiles()
          .map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime })),
      readBinary: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("The note was moved or deleted mid-sync.");
        return this.app.vault.readBinary(file);
      },
    };

    this.controller = new SyncController(
      {
        vault,
        transport,
        baseUrl: () => this.options.baseUrl,
        root: () => this.options.root,
        excludes: () => this.options.excludes,
        attachmentFolder: () => this.attachmentFolder(),
        configDir: () => this.app.vault.configDir,
        token: () => this.token(),
        setToken: (t) => this.setToken(t),
        loadCache: () => (this.app.loadLocalStorage(this.key("cache")) as HashCache | null) ?? {},
        saveCache: (cache) => this.app.saveLocalStorage(this.key("cache"), cache),
        confirmDeletion: (count) => confirmDeletion(this.app, count, this.options.root),
        onState: (state) => this.showState(state),
        onSynced: (last) => {
          this.options.lastSync = last;
          void this.saveData(this.options);
        },
      },
      () => void this.scheduler.now(),
    );
    this.scheduler = new Scheduler(() => this.controller.sync());

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.statusBar.onClickEvent(() => this.openSettings());
    this.showState(this.controller.state);

    this.settingTab = new ArchivistSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addCommand({ id: "connect", name: "Connect", callback: () => void this.connect() });

    // Registered once the workspace is ready, so the start-up `create` events don't count.
    this.app.workspace.onLayoutReady(() => {
      const changed = (file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "md") {
          this.controller.changed();
          this.scheduler.changed();
        }
      };
      this.registerEvent(this.app.vault.on("create", changed));
      this.registerEvent(this.app.vault.on("modify", changed));
      this.registerEvent(this.app.vault.on("delete", changed));
      this.registerEvent(this.app.vault.on("rename", changed));
      this.scheduler.setBackstop(this.options.intervalMinutes);
      if (this.token()) void this.scheduler.now();
    });
  }

  onunload() {
    this.scheduler?.stop();
    this.controller?.stop();
  }

  // --- The token, in Obsidian's secret storage (1.11.4+), which stays on this device.

  /** Device-local keys are per vault already; the secret ID also needs to be. */
  private key(name: string) {
    return `the-archivist-${name}`;
  }

  private secretId(): string {
    let id = this.app.loadLocalStorage(this.key("install")) as string | null;
    if (!id) {
      id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
      this.app.saveLocalStorage(this.key("install"), id);
    }
    return `the-archivist-${id}`;
  }

  token(): string | null {
    return this.app.secretStorage.getSecret(this.secretId()) || null;
  }

  setToken(token: string | null) {
    // Secret storage can't delete, so an empty secret means none.
    this.app.secretStorage.setSecret(this.secretId(), token ?? "");
  }

  private attachmentFolder(): string | null {
    const value = (this.app.vault as unknown as { getConfig?(k: string): unknown }).getConfig?.(
      "attachmentFolderPath",
    );
    // "/" is the vault root and "./…" is beside each note: neither is a folder to leave out.
    return typeof value === "string" && value !== "/" && !value.startsWith(".") ? value : null;
  }

  // --- Actions

  async syncNow() {
    if (!this.token()) {
      new Notice("Connect to The Archivist first.");
      return this.connect();
    }
    this.controller.changed();
    await this.scheduler.now();
    if (this.controller.state.kind === "idle") new Notice("Synced with The Archivist.");
  }

  async connect() {
    if (this.connecting) return;
    if (!isValidRoot(this.options.root)) {
      new Notice("Set a valid folder name in The Archivist's settings first.");
      return this.openSettings();
    }
    this.connecting = true;
    const api = createApi(this.options.baseUrl, null, transport);
    try {
      const start = await startConnecting(api, this.options.device, this.options.root);
      const modal = new ConnectModal(this.app, start.userCode, start.verificationUrl);
      modal.open();
      window.open(start.verificationUrl);
      const outcome: ConnectOutcome = await waitForApproval(api, start, {
        sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
        cancelled: () => modal.cancelled,
      });
      modal.close();
      if (outcome.status === "approved") {
        this.setToken(outcome.token);
        new Notice("Connected. Your notes will sync in the background.");
        this.controller.changed();
        this.showState({ kind: "idle" });
        void this.scheduler.now();
      } else if (outcome.status === "declined") new Notice("Not connected: it was declined in the browser.");
      else if (outcome.status === "expired") new Notice("The code expired. Connect again when you're ready.");
    } catch (err) {
      new Notice(
        err instanceof ApiError
          ? `Couldn't start connecting: ${err.message}`
          : "Couldn't reach The Archivist. Check your connection and try again.",
      );
    } finally {
      this.connecting = false;
      this.settingTab?.display();
    }
  }

  async disconnect() {
    const token = this.token();
    if (token) {
      try {
        await createApi(this.options.baseUrl, token, transport).delete("/api/tokens/current");
      } catch {
        // Offline or already revoked: forgetting it here still disconnects this device.
      }
    }
    this.setToken(null);
    this.showState({ kind: "disconnected" });
    new Notice("Disconnected from The Archivist.");
  }

  async changeRoot(root: string) {
    if (this.token()) await this.disconnect();
    this.options.root = root;
    this.options.lastSync = null;
    this.app.saveLocalStorage(this.key("cache"), null);
    await this.saveData(this.options);
  }

  async saveSettings() {
    await this.saveData(this.options);
    this.scheduler.setBackstop(this.options.intervalMinutes);
  }

  openSettings() {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  // --- Status

  private showState(state: SyncState) {
    if (this.statusBar) this.statusBar.setText(`Archivist: ${statusText(state, this.options.lastSync)}`);
    if (state.kind === "attention" && Platform.isMobile) new Notice(`The Archivist: ${state.message}`);
    if (state.kind === "disconnected" && state.reason) new Notice(`The Archivist: ${state.reason}`);
    this.settingTab?.refreshStatus();
  }
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${plural(hours, "hour")} ago` : new Date(iso).toLocaleDateString();
}

export function statusText(state: SyncState, last: LastSync | null): string {
  switch (state.kind) {
    case "disconnected":
      return "not connected";
    case "syncing": {
      const p = state.progress;
      if (p?.stage === "uploading") return `syncing ${p.done}/${p.total}`;
      if (p?.stage === "importing") return "importing";
      return "syncing";
    }
    case "waiting":
      return "needs attention";
    case "attention":
      return "needs attention";
    case "idle":
      return last ? `synced ${ago(last.at)}` : "connected";
  }
}

class ConnectModal extends Modal {
  cancelled = false;

  constructor(
    app: App,
    private readonly code: string,
    private readonly url: string,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle("Connect to The Archivist");
    contentEl.createEl("p", { text: "Approve this device in your browser. Check the code matches:" });
    contentEl.createEl("p", { text: this.code, cls: "the-archivist-code" });
    contentEl.createEl("p", {
      text: "If the browser didn't open, go to the address below on any device, signed in to your archive, and type the code.",
      cls: "setting-item-description",
    });
    contentEl.createEl("p", { text: this.url.replace(/\?.*$/, ""), cls: "the-archivist-url" });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Open the approval page").setCta().onClick(() => window.open(this.url)))
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => {
          this.cancelled = true;
          this.close();
        }),
      );
  }

  onClose() {
    // Closing the window any other way also stops waiting.
    this.cancelled = true;
    this.contentEl.empty();
  }
}

/** A yes-or-no question as a modal; closing it any other way counts as no. */
class ConfirmModal extends Modal {
  private resolve: ((yes: boolean) => void) | null = null;

  constructor(
    app: App,
    private readonly title: string,
    private readonly text: string,
    private readonly yes: string,
    private readonly no: string,
    private readonly warning = false,
  ) {
    super(app);
  }

  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private answer(yes: boolean) {
    this.resolve?.(yes);
    this.resolve = null;
  }

  onOpen() {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.text });
    new Setting(this.contentEl)
      .addButton((b) => {
        b.setButtonText(this.yes).onClick(() => {
          this.answer(true);
          this.close();
        });
        if (this.warning) b.setWarning();
        else b.setCta();
      })
      .addButton((b) =>
        b.setButtonText(this.no).onClick(() => {
          this.answer(false);
          this.close();
        }),
      );
  }

  onClose() {
    this.answer(false);
    this.contentEl.empty();
  }
}

function confirmDeletion(app: App, count: number, root: string): Promise<boolean> {
  return new ConfirmModal(
    app,
    `Remove ${plural(count, "note")} from your archive?`,
    `This sync would remove ${plural(count, "note")} from ${root} in your archive, because they're no longer in this vault. If that's not expected (the vault is still loading, or a folder is missing), choose Not now.`,
    "Remove them",
    "Not now",
    true,
  ).ask();
}

class ArchivistSettingTab extends PluginSettingTab {
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: ArchivistPlugin,
  ) {
    super(app, plugin);
  }

  refreshStatus() {
    if (!this.statusEl) return;
    const { state } = this.plugin.controller;
    const last = this.plugin.options.lastSync;
    let text = statusText(state, last);
    if (state.kind === "attention") text = state.message;
    if (state.kind === "disconnected" && state.reason) text = state.reason;
    this.statusEl.setText(text.charAt(0).toUpperCase() + text.slice(1) + ".");
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();
    this.statusEl = containerEl.createEl("p", { cls: "the-archivist-status" });
    this.refreshStatus();

    new Setting(containerEl).setName("Connection").setHeading();
    if (plugin.token()) {
      new Setting(containerEl)
        .setName("Connected")
        .setDesc(`As "${plugin.options.device}", syncing this vault to ${plugin.options.root}.`)
        .addButton((b) => b.setButtonText("Sync now").onClick(() => void plugin.syncNow()))
        .addButton((b) =>
          b.setButtonText("Disconnect").onClick(async () => {
            await plugin.disconnect();
            this.display();
          }),
        );
    } else {
      new Setting(containerEl)
        .setName("Not connected")
        .setDesc("Approve this device in your browser to start syncing. You need a beta account.")
        .addButton((b) => b.setButtonText("Connect").setCta().onClick(() => void plugin.connect()));
    }
    new Setting(containerEl)
      .setName("Device name")
      .setDesc("How this device appears in your archive's settings. Used when you next connect.")
      .addText((t) =>
        t.setValue(plugin.options.device).onChange(async (v) => {
          plugin.options.device = v.trim().slice(0, 60) || plugin.options.device;
          await plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Vault").setHeading();
    let rootDraft = plugin.options.root;
    new Setting(containerEl)
      .setName("Folder in your archive")
      .setDesc("Lower-case letters, digits, dots, dashes or underscores. Changing it starts a new folder and leaves the old one in the archive.")
      .addText((t) => t.setValue(plugin.options.root).onChange((v) => (rootDraft = v.trim())))
      .addButton((b) =>
        b.setButtonText("Change").onClick(async () => {
          if (rootDraft === plugin.options.root) return;
          if (!isValidRoot(rootDraft)) {
            new Notice("Use lower-case letters, digits, dots, dashes or underscores.");
            return;
          }
          const ok = plugin.options.lastSync
            ? await new ConfirmModal(
                this.app,
                `Sync this vault to ${rootDraft} instead?`,
                `The notes already in ${plugin.options.root} stay in your archive. You'll connect this device again.`,
                "Change folder",
                "Cancel",
              ).ask()
            : true;
          if (!ok) return;
          await plugin.changeRoot(rootDraft);
          this.display();
        }),
      );
    new Setting(containerEl)
      .setName("Leave out")
      .setDesc("Folders or patterns not to sync, one per line, such as a private folder or journal/**/drafts. Obsidian's settings folder, the trash and the attachment folder are always left out.")
      .addTextArea((t) =>
        t.setValue(plugin.options.excludes.join("\n")).onChange(async (v) => {
          plugin.options.excludes = v
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          await plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Also sync every")
      .setDesc("Changes sync about 2 minutes after you stop typing. This is a backstop.")
      .addDropdown((d) =>
        d
          .addOptions({ "5": "5 minutes", "15": "15 minutes", "60": "hour", "0": "never" })
          .setValue(String(plugin.options.intervalMinutes))
          .onChange(async (v) => {
            plugin.options.intervalMinutes = Number(v);
            await plugin.saveSettings();
          }),
      );

    const last = plugin.options.lastSync;
    if (last) {
      new Setting(containerEl).setName("Last sync").setHeading();
      containerEl.createEl("p", {
        text: `${new Date(last.at).toLocaleString()}: ${last.added} added, ${last.updated} updated, ${last.deleted} removed, ${last.skipped} skipped.`,
      });
      if (last.tooLarge.length > 0) {
        containerEl.createEl("p", { text: "Not synced, over 10 MB:", cls: "setting-item-description" });
        const list = containerEl.createEl("ul");
        for (const path of last.tooLarge) list.createEl("li", { text: path });
      }
    }

    new Setting(containerEl).setName("Advanced").setHeading();
    new Setting(containerEl)
      .setName("Archive address")
      .setDesc("Only change this for development.")
      .addText((t) =>
        t.setValue(plugin.options.baseUrl).onChange(async (v) => {
          plugin.options.baseUrl = v.trim().replace(/\/+$/, "") || DEFAULT_URL;
          await plugin.saveSettings();
        }),
      );
  }
}
