import { Notice, Plugin, requestUrl, TFile, TFolder } from "obsidian";
import { CloudRelaySettings, DEFAULT_SETTINGS } from "./settings";
import { StatusBar } from "./sync/status";
import { RelayConnection } from "./sync/connection";
import { NoteSyncManager } from "./sync/note-sync";
import { SyncStore } from "./sync/persist";
import { CloudRelaySettingTab } from "./ui/settings-tab";
import { ConflictModal } from "./ui/conflict-modal";

export default class CloudRelayPlugin extends Plugin {
  settings: CloudRelaySettings = DEFAULT_SETTINGS;
  private statusBar: StatusBar | null = null;
  private connection: RelayConnection | null = null;
  private syncManager: NoteSyncManager | null = null;
  private store: SyncStore | null = null;

  private async bootLog(msg: string) {
    try {
      const p = `${this.manifest.dir}/boot.log`;
      const stamp = new Date().toISOString();
      let prev = "";
      try {
        prev = await this.app.vault.adapter.read(p);
      } catch { /* sengaja diabaikan */ }
      const lines = prev.split("\n").filter(Boolean);
      while (lines.length > 100) lines.shift(); // jangan tumbuh tanpa batas
      await this.app.vault.adapter.write(
        p,
        `${lines.join("\n")}\n${stamp} ${msg}\n`
      );
    } catch { /* sengaja diabaikan */ }
  }

  async onload() {
    await this.loadSettings();
    await this.bootLog("onload start");

    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.store = new SyncStore(this.app.vault.adapter, `${this.manifest.dir}/sync`);
    this.syncManager = new NoteSyncManager(this.app, this.app.vault, this.store);
    this.syncManager.setConflictHandler((data) => {
      new ConflictModal(this.app, data, (choice) => {
        void this.syncManager?.resolveConflict(data.noteId, choice, data.local, data.remote, data.pendingUpdate, data.path);
      }).open();
    });

    try {
      await this.syncManager.init();
      await this.bootLog("init selesai");
    } catch (e) {
      await this.bootLog(`init ERROR: ${e}`);
    }

    this.registerVaultEvents();
    await this.bootLog("events terpasang");

    this.addRibbonIcon("refresh-cw", "Cloud Relay: sync sekarang", () => {
      if (this.connection && this.syncManager) {
        void this.syncManager.onDocList([]);
        void this.onConnectSync();
        new Notice("Cloud Relay: sync sekarang…");
      } else {
        new Notice("Cloud Relay: belum terhubung. Buka Settings → Cloud Relay.");
      }
    });

    this.addSettingTab(new CloudRelaySettingTab(this.app, this));

    if (this.settings.enabled && this.settings.vaultId) {
      await this.syncManager?.initFolders();
      this.startSync();
      void this.updateDeviceInfo();
      void this.syncManager
        ?.initHiddenFiles(false)
        .then(() => {
          void this.bootLog("initHidden selesai");
          void this.syncManager?.initAttachments(false);
        })
        .catch((e) => this.bootLog(`initHidden ERROR: ${e}`));
    }
  }

  onunload() {
    this.statusBar?.warnIfBusy();
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.stopSync();
    void this.syncManager?.flush();
  }

  private registerVaultEvents() {
    const manager = this.syncManager;
    if (!manager) return;

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) {
          if (file.extension === "md") {
            void this.app.vault.read(file).then((content) => manager.onFileCreate(file, content)).catch(() => {});
          } else {
            manager.onAttachmentChange(file);
          }
        } else if (file instanceof TFolder) {
          manager.onFolderChange(file.path, false);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          if (file.extension === "md") {
            void this.app.vault.read(file).then((content) => manager.onFileModify(file, content)).catch(() => {});
          } else {
            manager.onAttachmentChange(file);
          }
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          if (file.extension === "md") manager.onFileDelete(file);
          else manager.onAttachmentChange(file, true);
        } else if (file instanceof TFolder) {
          manager.onFolderChange(file.path, true);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          if (file.extension === "md") manager.onFileRename(file, oldPath);
          else manager.onAttachmentChange(file, false, oldPath);
        } else if (file instanceof TFolder) {
          manager.onFolderChange(file.path, false, oldPath);
        }
      })
    );
  }

  private onConnectSync() {
    if (this.connection && this.syncManager) {
      void this.syncManager.sendSyncSteps(this.connection);
    }
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<CloudRelaySettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async createVault(): Promise<boolean> {
    if (!this.settings.serverUrl) {
      new Notice("Cloud Relay: isi Server URL dulu.");
      return false;
    }
    if (!this.settings.adminToken) {
      new Notice("Cloud Relay: isi Admin token dulu (dari log server).");
      return false;
    }
    try {
      const res = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/v1/vaults`,
        method: "POST",
        headers: { "x-admin-token": this.settings.adminToken },
      });
      const body = res.json as unknown as { vault_id: string; token: string };
      this.settings.vaultId = body.vault_id;
      this.settings.vaultToken = body.token;
      this.settings.isPrimary = true;
      this.settings.enabled = true;
      await this.saveSettings();
      new Notice("Cloud Relay: vault berhasil dibuat ✓");
      this.startSync();
      return true;
    } catch (e) {
      const msg = `${e}`;
      if (msg.includes("401")) {
        new Notice(
          "Cloud Relay: admin token salah/belum diisi. Ambil dari server: docker compose logs | grep 'admin token'"
        );
      } else {
        new Notice(`Cloud Relay: tidak bisa menghubungi server (${msg}). Cek Server URL & tunnel.`);
      }
      return false;
    }
  }

  async wipeLocalVault(): Promise<{ moved: number; failed: number }> {
    const files = this.app.vault.getFiles();
    let moved = 0;
    let failed = 0;
    for (const file of files) {
      try {
        await this.app.fileManager.trashFile(file);
        moved++;
      } catch (e) {
        console.error("cloud-relay: gagal menghapus", file.path, e);
        failed++;
      }
    }
    return { moved, failed };
  }

  async fetchVaultInfo(
    serverUrl: string,
    vaultId: string,
    vaultToken: string
  ): Promise<{ lastUpdate: number; notes: number } | null> {
    try {
      const res = await requestUrl({
        url: `${serverUrl.replace(/\/$/, "")}/v1/vaults/${vaultId}/info?token=${encodeURIComponent(vaultToken)}`,
        method: "GET",
      });
      const body = res.json as unknown as { last_update: number; notes: number };
      return { lastUpdate: body.last_update, notes: body.notes };
    } catch {
      return null;
    }
  }

  async fetchVaultCounts(): Promise<{
    notes: number;
    attachments: number;
    folders: number;
    devices: number;
  } | null> {
    try {
      const res = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/v1/vaults/${this.settings.vaultId}/counts?token=${encodeURIComponent(this.settings.vaultToken)}`,
        method: "GET",
      });
      return res.json as unknown as {
        notes: number;
        attachments: number;
        folders: number;
        devices: number;
      };
    } catch {
      return null;
    }
  }

  async fetchVaultNoteIds(): Promise<string[] | null> {
    try {
      const res = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/v1/vaults/${this.settings.vaultId}/ids?token=${encodeURIComponent(this.settings.vaultToken)}`,
        method: "GET",
      });
      const body = res.json as unknown as { note_ids: string[] };
      // buang dokumen metadata internal dari hitungan catatan nyata
      return body.note_ids.filter((id) => !id.startsWith("__"));
    } catch {
      return null;
    }
  }

  syncDiagnostic() {
    return this.syncManager?.diagnostic() ?? { localNoteIds: [], pathById: {} };
  }

  attachmentDiagnostic() {
    return this.syncManager?.attachmentDiagnostic() ?? { local: 0, meta: 0 };
  }

  hiddenDiagnostic() {
    return this.syncManager?.hiddenDiagnostic() ?? Promise.resolve({ local: 0, meta: 0 });
  }

  folderDiagnostic() {
    return this.syncManager?.folderDiagnostic() ?? Promise.resolve({ local: 0, meta: 0 });
  }

  private scanning = false;

  async rescanVault(onProgress?: (msg: string) => void): Promise<boolean> {
    const progress = (msg: string) => {
      onProgress?.(msg);
    };
    if (this.scanning) {
      new Notice("Cloud Relay: sinkronisasi sedang berjalan, tunggu selesai…");
      return false;
    }
    this.scanning = true;
    try {
      progress("Mengosongkan server…");
      // 1) hapus SEMUA isi server vault
      await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/v1/vaults/${this.settings.vaultId}/reset?token=${encodeURIComponent(this.settings.vaultToken)}`,
        method: "POST",
      });

      // 2) bersihkan state lokal DULU (sebelum koneksi dibuka!) —
      //    kalau tidak, sync-exchange reconnect mengirim ID lama → dobel
      progress("Membersihkan data sync lokal…");
      await this.syncManager?.prepareFreshPush();

      // 3) reconnect bersih — koneksi BARU dengan state kosong
      this.stopSync();
      this.startSync();

      const waitOpen = new Promise<void>((resolve, reject) => {
        const t = window.setTimeout(
          () => reject(new Error("koneksi server tidak terbuka dalam 15 detik")),
          15000
        );
        const poll = window.setInterval(() => {
          if (this.connection && this.connection.isOpen()) {
            window.clearInterval(poll);
            window.clearTimeout(t);
            resolve();
          }
        }, 250);
      });
      await waitOpen;

      // 4) rebuild lokal dari file fisik + push full state SEMUA dokumen
      await this.syncManager?.executeFreshPush((msg) => progress(msg));

      // 4) tulis info device terbaru
      progress("Memperbarui info device…");
      await this.syncManager?.updateOwnDeviceInfo(
        this.settings.isPrimary ? "sumber pertama" : "pengikut"
      );

      // 5) verifikasi: jumlah catatan server harus == jumlah lokal
      progress("Memverifikasi hasil di server…");
      await new Promise((r) => window.setTimeout(r, 2500));
      const local = this.app.vault.getMarkdownFiles().length;
      const counts = await this.fetchVaultCounts();
      if (counts !== null && counts.notes !== local) {
        progress(
          `Selesai dengan catatan: server ${counts.notes} vs lokal ${local}. Klik Cek sekarang.`
        );
        new Notice(
          `Cloud Relay: perlu dicek — server ${counts.notes} vs lokal ${local}. Klik Cek sekarang.`,
          8000
        );
        return false;
      }
      progress(
        `Selesai ✓ Server kini 100% sama: ${local} catatan, ${counts?.attachments ?? "?"} lampiran, ${counts?.folders ?? "?"} folder.`
      );
      new Notice("Cloud Relay: server kini 100% sama dengan vault ini ✓");
      return true;
    } catch (e) {
      progress(`Gagal: ${e}`);
      new Notice(`Cloud Relay: sinkronisasi paksa gagal — ${e}`);
      console.error("cloud-relay: force sync gagal", e);
      return false;
    } finally {
      this.scanning = false;
    }
  }

  async rescanVaultLight() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.syncManager?.init(true);
    } finally {
      this.scanning = false;
    }
  }

  listDevices() {
    return this.syncManager?.listDevices() ?? [];
  }

  async updateDeviceInfo() {
    await this.syncManager?.updateOwnDeviceInfo(
      this.settings.isPrimary ? "sumber pertama" : "pengikut"
    );
  }

  async syncSummary() {
    const base = await this.syncManager?.syncSummary();
    if (!base) return null;
    const counts = await this.fetchVaultCounts();
    return {
      ...base,
      serverNotes: counts === null ? -1 : counts.notes,
      serverAttachments: counts === null ? -1 : counts.attachments,
      serverFolders: counts === null ? -1 : counts.folders,
    };
  }

  async resetServerVault(): Promise<boolean> {
    return this.rescanVault((message) => new Notice(`Cloud Relay: ${message}`));
  }

  async resetLocalSync() {
    await this.syncManager?.reset();
  }

  async testConnection(
    serverUrl: string,
    vaultId: string,
    vaultToken: string
  ): Promise<{ ok: boolean; message: string; notes?: number; lastUpdate?: number }> {
    try {
      const res = await requestUrl({
        url: `${serverUrl.replace(/\/$/, "")}/v1/vaults/${vaultId}/info?token=${encodeURIComponent(vaultToken)}`,
        method: "GET",
      });
      const body = res.json as unknown as { last_update: number; notes: number };
      return {
        ok: true,
        message: "Server merespons",
        notes: body.notes,
        lastUpdate: body.last_update,
      };
    } catch (e) {
      return { ok: false, message: `${e}`.slice(0, 120) };
    }
  }

  applyLimits() {
    this.syncManager?.setMaxNoteBytes((this.settings.maxNoteMB || 0) * 1024 * 1024);
    this.syncManager?.setHiddenSyncEnabled(this.settings.hiddenSync !== false);
  }

  async recoverFromServer(): Promise<boolean> {
    return this.refreshFromServer((message) => new Notice(`Cloud Relay: ${message}`));
  }

  async refreshFromServer(onProgress?: (message: string) => void): Promise<boolean> {
    if (!this.syncManager || !this.settings.vaultId) return false;
    if (this.scanning) return false;
    this.scanning = true;
    const progress = (message: string) => onProgress?.(message);
    try {
      progress("Memeriksa jumlah data server…");
      const before = await this.fetchVaultCounts();
      if (!before) throw new Error("server tidak bisa diverifikasi");
      this.stopSync();
      this.syncManager.suspend();
      progress("Mengosongkan vault lokal…");
      await this.syncManager.reset();
      let removed = 0;
      for (const file of this.app.vault.getFiles()) {
        try {
          await this.app.fileManager.trashFile(file);
          removed++;
        } catch (e) {
          console.error("cloud-relay: gagal mengosongkan", file.path, e);
        }
      }
      this.syncManager.resumeAfterReset();
      await this.saveSettings();
      progress(`Vault lokal kosong (${removed} file), menarik ${before.notes} catatan dari server…`);
      this.startSync();
      const deadline = Date.now() + 60000;
      let last = -1;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        const counts = await this.fetchVaultCounts();
        const local = this.app.vault.getMarkdownFiles().length;
        if (local !== last) {
          last = local;
          progress(`Menarik data server… ${local}/${before.notes} catatan`);
        }
        if (counts && local === counts.notes && local === before.notes && this.syncManager.applyQueueSize() === 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          const finalCounts = await this.fetchVaultCounts();
          const finalLocal = this.app.vault.getMarkdownFiles().length;
          if (finalCounts && finalLocal === finalCounts.notes && finalLocal === before.notes) {
            progress(`Selesai: ${finalLocal}/${before.notes} catatan sama dengan server`);
            new Notice(`Cloud Relay: vault lokal sudah mengikuti server (${finalLocal} catatan) ✓`);
            return true;
          }
        }
        if (this.connection?.isOpen()) await this.syncManager.sendSyncSteps(this.connection);
      }
      throw new Error(`data belum lengkap setelah 60 detik: lokal ${this.app.vault.getMarkdownFiles().length}, server ${before.notes}`);
    } catch (e) {
      progress(`Gagal: ${e}`);
      new Notice(`Cloud Relay: ikuti server gagal — ${e}`);
      return false;
    } finally {
      this.scanning = false;
    }
  }

  startSync() {
    if (!this.syncManager) return;
    this.syncManager.setHttpTransport({
      baseUrl: this.settings.serverUrl,
      token: this.settings.vaultToken,
    });
    this.applyLimits();
    this.statusBar?.resetStats();
    this.connection = new RelayConnection(
      (status) => this.statusBar?.set(status),
      {
        onDocList: (ids) => {
          void this.syncManager?.initFolders();
          void this.updateDeviceInfo();
          void this.syncManager?.onDocList(ids);
          void this.syncManager?.initHiddenFiles(false);
          void this.onConnectSync();
        },
        onSyncStep1: (id, sv) => this.syncManager?.onSyncStep1(id, sv),
        onSyncStep2: (id, up) => this.syncManager?.onSyncStep2(id, up),
        onUpdate: (id, up) => this.syncManager?.onUpdate(id, up),
        onSent: (n) => this.statusBar?.addSent(n),
        onReceived: (n) => this.statusBar?.addReceived(n),
      }
    );
    this.syncManager.setConn(this.connection);
    this.hiddenWatchStarted = Date.now();
    this.hiddenWatchSeen.clear();
    this.startHiddenWatcher();
    this.connection.connect(
      this.settings.serverUrl,
      this.settings.vaultId,
      this.settings.vaultToken
    );
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.statsTimer = window.setInterval(() => {
      if (this.statusBar) {
        this.statusBar.setQueued(this.syncManager?.applyQueueSize() ?? 0);
      }
    }, 500);
  }

  private statsTimer: number | null = null;

  private hiddenWatcherTimer: number | null = null;
  private hiddenWatchSeen = new Map<string, number>();

  private startHiddenWatcher() {
    if (this.hiddenWatcherTimer !== null) return;
    this.hiddenWatcherTimer = window.setInterval(() => {
      void this.pollHiddenFiles();
    }, 5000);
  }

  private async pollHiddenFiles() {
    if (!this.syncManager || !this.settings.hiddenSync) return;
    const prev = this.hiddenWatchSeen;
    const cur = new Map<string, number>();
    try {
      const list = await this.app.vault.adapter.list(this.app.vault.configDir);
      const allowed = [
        "app.json", "appearance.json", "community-plugins.json",
        "core-plugins.json", "hotkeys.json", "graph.json",
      ];
      for (const f of list.files) {
        const cfgDir = this.app.vault.configDir;
        const rel = f.startsWith(cfgDir + "/") ? f.slice(cfgDir.length + 1) : "";
        if (!rel || rel.startsWith("plugins/cloud-relay/")) continue;
        if (
          !allowed.includes(rel) &&
          !rel.startsWith("themes/") &&
          !rel.startsWith("snippets/")
        )
          continue;
        const st = await this.app.vault.adapter.stat(f);
        if (st?.mtime) cur.set(rel, st.mtime);
      }
    } catch { /* sengaja diabaikan */ }
    const firstPoll = !this.hiddenFirstPollDone;
    this.hiddenFirstPollDone = true;
    for (const [rel, mtime] of cur) {
      if (!prev.has(rel) || prev.get(rel) !== mtime) {
        const isNewFile = !prev.has(rel);
        prev.set(rel, mtime);
        // poll pertama = seeding baseline (jangan upload semua); setelah itu,
        // file baru maupun mtime berubah sama-sama dilaporkan
        if (!firstPoll || isNewFile === false) {
          if (!firstPoll) this.syncManager.onHiddenFileChange(rel);
        }
      }
    }
    for (const rel of Array.from(prev.keys())) {
      if (!cur.has(rel)) {
        prev.delete(rel);
        if (!firstPoll) this.syncManager.onHiddenFileChange(rel, true);
      }
    }
  }

  private hiddenWatchStarted = 0;
  private hiddenFirstPollDone = false;

  private stopHiddenWatcher() {
    if (this.hiddenWatcherTimer !== null) {
      window.clearInterval(this.hiddenWatcherTimer);
      this.hiddenWatcherTimer = null;
    }
  }

  stopSync() {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.stopHiddenWatcher();
    this.syncManager?.setConn(null);
    this.connection?.disconnect();
    this.connection = null;
    this.statusBar?.set("disconnected");
  }
}

