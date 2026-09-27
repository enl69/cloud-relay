// Stub modul "obsidian" untuk test di Node.
// Dipakai via esbuild alias saat bundling test entry.

export class TFile {
  path: string;
  name: string;
  extension: string;
  stat: { mtime: number; size: number; ctime: number };

  constructor(path: string, stat?: { mtime: number; size: number }) {
    this.path = path;
    this.name = path.split("/").pop() ?? "";
    this.extension = this.name.includes(".")
      ? this.name.split(".").pop()!
      : "";
    this.stat = stat ?? {
      mtime: Date.now(),
      size: 0,
      ctime: Date.now(),
    };
    this.stat.size = this.stat.size ?? 0;
    this.stat.ctime = this.stat.ctime ?? this.stat.mtime;
  }
}

export class TFolder {
  path: string;
  name: string;
  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() ?? "";
  }
}

export class TAbstractFile {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
}

export class Notice {
  static notices: string[] = [];
  constructor(public message: string, public timeout?: number) {
    Notice.notices.push(message);
    console.log("[Notice]", message);
  }
}

export class Plugin {
  manifest = { dir: ".obsidian/plugins/cloud-relay", version: "test" };
  app: unknown;
  async loadData() {
    return {};
  }
  async saveData() {}
  addStatusBarItem() {
    return {
      setText() {},
      setAttribute() {},
      el: document.createElement("div"),
    };
  }
  addRibbonIcon() {}
  addSettingTab() {}
  registerEvent() {}
  register() {}
  registerDomEvent() {}
}

export class PluginSettingTab {
  constructor() {}
  display() {}
}

export class Setting {
  constructor(public containerEl: HTMLElement) {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText() {
    return this;
  }
  addButton() {
    return this;
  }
  addToggle() {
    return this;
  }
}

export class MarkdownView {}

const blobStore = new Map<string, ArrayBuffer>();

export function requestUrl(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  throw?: boolean;
}): Promise<{ status: number; json: any; arrayBuffer?: ArrayBuffer; text: string }> {
  const m = opts.url.match(/\/v1\/blobs\/([0-9a-f]{64})/);
  if (!m) {
    return Promise.resolve({ status: 404, json: {}, text: "" });
  }
  const sha = m[1];
  if (opts.method === "PUT") {
    blobStore.set(sha, opts.body ?? new ArrayBuffer(0));
    return Promise.resolve({ status: 201, json: {}, text: "" });
  }
  if (blobStore.has(sha)) {
    return Promise.resolve({
      status: 200,
      json: {},
      arrayBuffer: blobStore.get(sha),
      text: "",
    });
  }
  return Promise.resolve({ status: 404, json: {}, text: "" });
}

export function normalizePath(p: string) {
  return p;
}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: true,
  isWin: false,
  isLinux: false,
};
