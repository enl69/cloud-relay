import { App, Modal, Notice } from "obsidian";

export interface ConflictChoice {
  noteId: string;
  path: string;
  local: string;
  remote: string;
  deleted: boolean;
}

type Choice = "local" | "remote" | "merge";

function buildResult(choice: Choice, local: string, remote: string): string {
  if (choice === "local") return local;
  if (choice === "remote") return remote;
  return `${local}\n\n--- versi device lain (digabung) ---\n\n${remote}`;
}

export class ConflictModal extends Modal {
  private selected: Choice | null = null;

  constructor(
    app: App,
    private conflict: ConflictChoice,
    private choose: (choice: Choice) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cloud-relay-conflict-modal");
    contentEl.createEl("h2", { text: "Dua versi berbeda ditemukan" });
    contentEl.createEl("p", {
      text: `"${this.conflict.path}" diubah di device ini dan device lain saat offline. Kedua versi masih utuh — pilih versi mana yang dipakai. Tidak ada file yang didobel.`,
    });

    const wrap = contentEl.createDiv({ cls: "cloud-relay-conflict-body" });

    // versi lokal
    const localCard = wrap.createDiv({ cls: "cloud-relay-conflict-card" });
    localCard.createEl("h4", { text: "Versi device ini" });
    const localPre = localCard.createEl("pre", {
      text: this.conflict.local.slice(0, 1500) || "(kosong / terhapus)",
    });

    // versi remote
    const remoteCard = wrap.createDiv({ cls: "cloud-relay-conflict-card" });
    remoteCard.createEl("h4", { text: "Versi device lain" });
    const remotePre = remoteCard.createEl("pre", {
      text: this.conflict.remote.slice(0, 1500) || "(kosong / terhapus)",
    });
    void localPre;
    void remotePre;

    // area pratinjau hasil
    const previewEl = contentEl.createDiv({
      cls: "cloud-relay-conflict-preview-result",
    });
    previewEl.style.display = "none";
    previewEl.createEl("h4", { text: "Pratinjau versi yang akan dipakai" });
    const previewPre = previewEl.createEl("pre", { text: "" });

    const renderPreview = (choice: Choice) => {
      this.selected = choice;
      previewEl.style.display = "block";
      previewPre.setText(
        buildResult(choice, this.conflict.local, this.conflict.remote).slice(
          0,
          1500
        )
      );
      for (const btn of buttons) {
        btn.removeClass("cloud-relay-choice-active");
      }
      const activeBtn = buttons.find((b) => b.dataset.choice === choice);
      activeBtn?.addClass("cloud-relay-choice-active");
    };

    // tombol pilihan
    const actions = contentEl.createDiv({ cls: "cloud-relay-conflict-actions" });
    const buttons: HTMLButtonElement[] = [];
    const options: Array<[string, Choice]> = [
      ["Pakai versi device ini", "local"],
      ["Pakai versi device lain", "remote"],
      ["Gabungkan keduanya", "merge"],
    ];
    for (const [label, choice] of options) {
      const button = actions.createEl("button", { text: label });
      button.dataset.choice = choice;
      button.addEventListener("click", () => renderPreview(choice));
      buttons.push(button);
    }

    // konfirmasi
    const confirmRow = contentEl.createDiv({
      cls: "cloud-relay-conflict-confirm",
    });
    const confirmBtn = confirmRow.createEl("button", {
      text: "Konfirmasi pilihan",
      cls: "mod-cta",
    });
    confirmBtn.disabled = true;
    confirmBtn.addEventListener("click", () => {
      if (!this.selected) return;
      this.choose(this.selected);
      this.close();
      new Notice("Cloud Relay: konflik diselesaikan, versi terpilih disebarkan ke semua device");
    });
    const observe = () => {
      confirmBtn.disabled = this.selected === null;
    };
    observe();
    const poll = window.setInterval(observe, 200);
    const origClose = this.onClose.bind(this);
    this.onClose = () => {
      window.clearInterval(poll);
      origClose();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}
