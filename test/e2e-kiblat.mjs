// E2E KIBLAT SERVER: server = kiblat — 1 path = 1 note, dobel DITOLAK,
// data lama disweep otomatis. Menguji aturan yang user tetapkan:
//   1. Device (plugin lama / index basi) kirim note-id BEDA untuk path milik
//      note lain → server tolak, tidak pernah tersimpan, balas state pemilik.
//   2. Dua device klaim path BARU yang sama hampir bersamaan → tepat SATU
//      yang diterima (write_lock atomik — race tertutup).
//   3. Dobel warisan (disuntik langsung ke DB era lama) → /dedup sweep
//      membersihkan; note sah selamat, device sah tidak kehilangan data.
// Jalankan: RELAY_URL=... RELAY_ADMIN=... RELAY_DATA_DIR=... node test/e2e-kiblat.mjs
// Server debug: cd ../db-cloud-relay && RELAY_DATA_DIR=/tmp/relay-kiblat PORT=18099 cargo run
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require("./entry.bundle.cjs");
const assert = require("assert");
const Y = M.Y;

const { NoteSyncManager, TFile, MockVault, encodeFrame, decodeFrame } = M;

const BASE = process.env.RELAY_URL ?? "http://localhost:18099";
const ADMIN = process.env.RELAY_ADMIN ?? "";
const DATA_DIR = process.env.RELAY_DATA_DIR ?? "/tmp/relay-kiblat";

globalThis.window = globalThis;
globalThis.WebSocket = WebSocket;

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, init) => {
  const u = String(url);
  if (u.includes("/v1/blobs/")) {
    return realFetch(`${BASE}${u.slice(u.indexOf("/v1/"))}`, init);
  }
  return realFetch(url, init);
};

import fs from "fs";
import path from "path";
import os from "os";
function makeDiskStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    async ensureDir() {},
    async readBlob(id) {
      const p = path.join(dir, id + ".bin");
      return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
    },
    async writeBlob(id, data) {
      fs.writeFileSync(path.join(dir, id + ".bin"), data);
    },
    async readSv(id) {
      const p = path.join(dir, id + ".sv");
      return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
    },
    async writeSv() {},
    async readIndex() {
      const p = path.join(dir, "index.json");
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    },
    async writeIndex(idx) {
      fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx, null, 2));
    },
    async readAttachSeen() {
      const p = path.join(dir, "attach-seen.json");
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    },
    async writeAttachSeen(s) {
      fs.writeFileSync(path.join(dir, "attach-seen.json"), JSON.stringify(s, null, 2));
    },
    async readHiddenSeen() {
      const p = path.join(dir, "hidden-seen.json");
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    },
    async writeHiddenSeen(s) {
      fs.writeFileSync(path.join(dir, "hidden-seen.json"), JSON.stringify(s, null, 2));
    },
    async archive() {},
  };
}

function makeDevice(tag) {
  const vault = new MockVault();
  const store = makeDiskStore(path.join(os.tmpdir(), `relay-kiblat-${tag}-${Date.now()}`));
  const app = { vault, fileManager: { trashFile: async (fl) => { await vault.trash(fl, true); } } };
  const manager = new NoteSyncManager(app, vault, store);
  manager.setConflictHandler(async (data) => {
    await manager.resolveConflict(data.noteId, "merge", data.local, data.remote, data.pendingUpdate, data.path);
  });
  vault.on("create", (file) => {
    if (file instanceof TFile) {
      if (file.extension === "md") {
        vault.read(file).then((c) => manager.onFileCreate(file, c));
      } else {
        manager.onAttachmentChange(file);
      }
    }
  });
  vault.on("modify", (file) => {
    if (file instanceof TFile) {
      if (file.extension === "md") {
        vault.read(file).then((c) => manager.onFileModify(file, c));
      } else {
        manager.onAttachmentChange(file);
      }
    }
  });
  vault.on("delete", (file) => {
    if (file instanceof TFile) {
      if (file.extension === "md") manager.onFileDelete(file);
      else manager.onAttachmentChange(file, true);
    }
  });
  vault.on("rename", (file, oldPath) => {
    if (file instanceof TFile) {
      if (file.extension === "md") manager.onFileRename(file, oldPath);
      else manager.onAttachmentChange(file, false, oldPath);
    }
  });
  const Conn = M.RelayConnection;
  const conn = new Conn(
    () => {},
    {
      onDocList: (ids) => void manager.onDocList(ids),
      onSyncStep1: (id, sv) => void manager.onSyncStep1(id, sv),
      onSyncStep2: (id, up) => void manager.onSyncStep2(id, up),
      onUpdate: (id, up) => void manager.onUpdate(id, up),
    }
  );
  manager.setConn(conn);
  manager.setHttpTransport({ baseUrl: BASE, token: "" });
  return { tag, vault, store, manager, conn };
}

// ---------- rogue: device lama mentah (raw WS, kirim apa adanya) ----------
function buildRogueUpdate(filePath, content) {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  const meta = doc.getMap("meta");
  doc.transact(() => {
    text.insert(0, content);
    meta.set("path", filePath);
  });
  return new Uint8Array(Y.encodeStateAsUpdate(doc));
}

async function connectRogue(vid, vtok) {
  const ws = new WebSocket(
    `${BASE.replace(/^http/, "ws")}/sync/${vid}?token=${vtok}`
  );
  ws.binaryType = "arraybuffer"; // default "blob" tidak bisa di-decode
  const rogue = { ws, frames: [] };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error("rogue ws error"));
    setTimeout(() => rej(new Error("rogue ws timeout")), 8000);
  });
  ws.onmessage = (ev) => {
    const f = decodeFrame(new Uint8Array(ev.data));
    if (f) rogue.frames.push(f);
  };
  await new Promise((r) => setTimeout(r, 300)); // terima DOC_LIST dulu
  return rogue;
}

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}\n      ${e.message.split("\n")[0]}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 800) { await sleep(ms); }

async function getIds(vid, vtok) {
  const r = await realFetch(`${BASE}/v1/vaults/${vid}/ids?token=${vtok}`);
  const j = await r.json();
  return j.note_ids;
}
async function getCounts(vid, vtok) {
  const r = await realFetch(`${BASE}/v1/vaults/${vid}/counts?token=${vtok}`);
  return await r.json();
}

(async () => {
  console.log("\n=== SETUP: buat vault di server nyata ===");
  const resp = await realFetch(`${BASE}/v1/vaults`, {
    method: "POST",
    headers: { "x-admin-token": ADMIN },
  });
  assert.equal(resp.status, 200, "create vault");
  const { vault_id: VID, token: VTOK } = await resp.json();
  console.log(`vault: ${VID}`);
  assert.ok(VID && VTOK);

  // ============================================================
  console.log("\n=== KIBLAT 1: note-id beda utk path milik note lain → DITOLAK ===");
  const A = makeDevice("A");
  A.manager.setHttpTransport({ baseUrl: BASE, token: VTOK });
  A.vault.fsWrite("sama.md", "isi A");
  await A.manager.init();
  await A.conn.connect(BASE, VID, VTOK);
  await sleep(1500);
  await A.manager.sendSyncSteps(A.conn);
  await settle(1500);

  const ids0 = await getIds(VID, VTOK);
  const ownerNoteId = ids0.find((id) => !id.startsWith("__"));
  assert.ok(ownerNoteId, "note sah A harus ada di server");
  const counts0 = await getCounts(VID, VTOK);
  console.log(`  pemilik sah: ${ownerNoteId} | notes=${counts0.notes}`);

  const rogue = await connectRogue(VID, VTOK);
  const rogueId = "rogue-" + Math.random().toString(36).slice(2, 10);

  await test("update dobel DITOLAK — tidak tersimpan di server", async () => {
    rogue.ws.send(encodeFrame(3, rogueId, buildRogueUpdate("sama.md", "isi A")));
    await settle(900);
    const ids = await getIds(VID, VTOK);
    assert.ok(!ids.includes(rogueId), `rogue id (${rogueId}) TIDAK boleh tersimpan: ${ids.join(",")}`);
    const counts = await getCounts(VID, VTOK);
    assert.equal(counts.notes, counts0.notes, "jumlah catatan server tidak boleh bertambah");
  });

  await test("server balas state pemilik sah (bukan dobel)", async () => {
    // penolakan dikirim sebagai UPDATE utk note-id PEMILIK
    assert.ok(
      rogue.frames.some((f) => f.type === 3 && f.noteId === ownerNoteId),
      "rogue harus menerima state pemilik sebagai UPDATE"
    );
  });

  await test("penolakan idempoten — rogue kirim ulang tetap ditolak", async () => {
    rogue.ws.send(encodeFrame(3, rogueId, buildRogueUpdate("sama.md", "isi A sedikit beda")));
    await settle(900);
    const ids = await getIds(VID, VTOK);
    assert.ok(!ids.includes(rogueId), "tetap tidak tersimpan");
    const counts = await getCounts(VID, VTOK);
    assert.equal(counts.notes, counts0.notes);
  });

  await test("device sah A tidak terganggu", async () => {
    const f = A.vault.getAbstractFileByPath("sama.md");
    assert.ok(f, "file A tetap ada");
    const content = new TextDecoder().decode(A.vault.adapter.files.get("sama.md").data);
    assert.equal(content, "isi A");
  });

  // ============================================================
  console.log("\n=== KIBLAT 2: dua device klaim path BARU bersamaan → tepat 1 ===");
  await test("race klaim path baru — hanya satu pemilik diterima", async () => {
    const r1 = await connectRogue(VID, VTOK);
    const r2 = await connectRogue(VID, VTOK);
    const upd = buildRogueUpdate("race.md", "isi race");
    // kirim berdua SECEPAT MUNGKIN tanpa jeda — race nyata
    r1.ws.send(encodeFrame(3, "race-id-satu", upd));
    r2.ws.send(encodeFrame(3, "race-id-dua", upd));
    await settle(1500);
    const ids = await getIds(VID, VTOK);
    const present = ["race-id-satu", "race-id-dua"].filter((id) => ids.includes(id));
    assert.equal(present.length, 1, `tepat satu pemilik race.md yang tersimpan (nyata: ${present.join(",")})`);
    const counts = await getCounts(VID, VTOK);
    assert.equal(counts.notes, counts0.notes + 1, "notes bertambah tepat 1");
    r1.ws.close();
    r2.ws.close();
  });

  // ============================================================
  console.log("\n=== KIBLAT 3: dobel warisan (era lama) → sweep membersihkan ===");
  await test("dedup sweep hapus dobel warisan, note sah selamat", async () => {
    const { execSync } = require("child_process");
    const fakeId = "legacy-dup-" + Math.random().toString(36).slice(2, 10);
    const upd = buildRogueUpdate("sama.md", "isi A");
    const hex = Buffer.from(upd).toString("hex");
    // suntik langsung ke DB — mensimulasikan dobel era sebelum aturan kiblat
    execSync(
      `sqlite3 "${DATA_DIR}/relay.db" "INSERT INTO updates (vault_id, note_id, data) VALUES ('${VID}', '${fakeId}', X'${hex}')"`,
      { stdio: "pipe" }
    );
    const before = await getIds(VID, VTOK);
    assert.ok(before.includes(fakeId), "dup warisan masuk (sebelum sweep)");

    const r = await realFetch(`${BASE}/v1/vaults/${VID}/dedup?token=${VTOK}`, {
      method: "POST",
    });
    assert.equal(r.status, 200, "dedup endpoint");
    const j = await r.json();
    assert.ok(j.removed >= 1, `sweep harus menghapus dup (removed=${j.removed})`);

    const after = await getIds(VID, VTOK);
    assert.ok(!after.includes(fakeId), "dup warisan hilang");
    assert.ok(after.includes(ownerNoteId), "note sah tetap ada");
  });

  await test("setelah sweep + reconnect, A tidak kehilangan data", async () => {
    await settle(3500); // tunggu reconnect (generation bump memutus koneksi basi)
    const f = A.vault.getAbstractFileByPath("sama.md");
    assert.ok(f, "file A tetap ada pasca sweep");
    const counts = await getCounts(VID, VTOK);
    assert.equal(counts.notes, counts0.notes + 1, "notes = asli + race (dup bersih)");
    const ids = await getIds(VID, VTOK);
    assert.ok(ids.includes(ownerNoteId), "ID kanonik A bertahan");
  });

  // ============================================================
  console.log(`\n=== HASIL E2E KIBLAT: ${passed} lulus, ${failed} gagal ===`);
  A.conn.disconnect();
  try { rogue.ws.close(); } catch {}
  if (failed > 0) {
    console.log("\nDetail:");
    for (const f of failures) {
      console.log(`\n--- ${f.name} ---`);
      console.log(f.error.stack ?? f.error.message);
    }
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
