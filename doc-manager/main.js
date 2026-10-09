const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const indexer = require("./lib/indexer");
const { CATEGORIES } = require("./lib/classify");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let settings = null;
let index = null;
let scanning = false;
let scanAgain = false;
let progress = null;
let watcher = null;
let watchTimer = null;
let lastFocusScan = 0;

const userFile = (name) => path.join(app.getPath("userData"), name);

const DEFAULT_SETTINGS = { root: "", partners: [], tagRules: [] };

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(userFile("settings.json"), "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(userFile("settings.json"), JSON.stringify(settings, null, 2));
}

function classifyOptions() {
  return { partners: settings.partners, tagRules: settings.tagRules };
}

function persistIndex() {
  if (index && index.root) indexer.saveIndex(userFile("index.json"), index);
}

// 화면에 보내는 문서 정보. 본문 전체는 보내지 않고 앞부분만 보낸다.
function docSummary(e) {
  const p = indexer.nameParts(e.rel);
  const eff = indexer.effective(e);
  return {
    rel: e.rel,
    base: p.base,
    name: p.name,
    ext: p.ext,
    dir: p.dir,
    kind: e.kind,
    size: e.size,
    mtimeMs: e.mtimeMs,
    birthtimeMs: e.birthtimeMs,
    pages: e.pages,
    title: e.title,
    author: e.author,
    error: e.error,
    hasText: !!e.text,
    category: eff.category,
    autoCategory: e.autoCategory,
    userCategory: e.userCategory || "",
    reasons: e.reasons || [],
    tags: eff.tags,
    autoTags: e.autoTags || [],
    userTags: e.userTags || [],
    hiddenTags: e.hiddenTags || [],
    note: e.note || "",
    starred: !!e.starred,
  };
}

function state() {
  return {
    root: settings.root,
    settings,
    categories: CATEGORIES,
    scanning,
    progress,
    docs: index ? Object.values(index.files).map(docSummary) : [],
  };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function runScan() {
  if (!index || !index.root) return;
  if (scanning) {
    scanAgain = true;
    return;
  }
  if (!fs.existsSync(index.root)) {
    send("scan-error", "폴더를 찾을 수 없습니다: " + index.root);
    return;
  }
  scanning = true;
  send("state", state());
  try {
    let lastSend = 0;
    const r = await indexer.scan(index, classifyOptions(), (p) => {
      progress = p;
      const now = Date.now();
      if (now - lastSend > 150) {
        lastSend = now;
        send("progress", p);
      }
    });
    persistIndex();
    send("scan-done", { added: r.added, updated: r.updated, removed: r.removed });
  } catch (e) {
    send("scan-error", String((e && e.message) || e));
  } finally {
    scanning = false;
    progress = null;
    send("state", state());
  }
  if (scanAgain) {
    scanAgain = false;
    runScan();
  }
}

// 폴더 안에서 파일이 바뀌면 잠시 기다렸다가 다시 훑는다. (저장 중인 파일을 반쯤 읽지 않도록)
function startWatching() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (!settings.root) return;
  try {
    watcher = fs.watch(settings.root, { recursive: true }, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(runScan, 2500);
    });
    watcher.on("error", () => {});
  } catch {
    // 감시가 안 되는 환경이면 창으로 돌아올 때마다 다시 훑는 것으로 대신한다.
    watcher = null;
  }
}

function openRoot(root) {
  settings.root = root;
  saveSettings();
  index = root ? indexer.loadIndex(userFile("index.json"), root) : null;
  startWatching();
  send("state", state());
  runScan();
}

function fullPath(rel) {
  const full = path.resolve(index.root, ...rel.split("/"));
  // 색인된 폴더 밖의 파일은 열지 않는다.
  if (!index.files[rel] || path.relative(index.root, full).startsWith("..")) throw new Error("알 수 없는 파일");
  return full;
}

// 검색어 주변 글자를 잘라서 보여 준다.
function snippetAround(text, terms) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    at = lower.indexOf(t);
    if (at >= 0) break;
  }
  if (at < 0) return "";
  const start = Math.max(0, at - 50);
  return (start > 0 ? "…" : "") + text.slice(start, at + 110).replace(/\s+/g, " ") + "…";
}

function search(query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || !index) return [];
  const out = [];
  for (const e of Object.values(index.files)) {
    const eff = indexer.effective(e);
    const meta = [e.rel, e.title, e.author, e.note || "", eff.tags.join(" ")].join("\n").toLowerCase();
    const text = (e.text || "").toLowerCase();
    let score = 0;
    let ok = true;
    for (const t of terms) {
      if (meta.includes(t)) score += 10;
      else if (text.includes(t)) score += 1;
      else { ok = false; break; }
    }
    if (ok) out.push({ rel: e.rel, score, snippet: snippetAround(e.text || "", terms) });
  }
  return out;
}

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function registerIpc() {
  ipcMain.handle("get-state", () => state());

  ipcMain.handle("choose-folder", async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "문서를 모아 둔 폴더 선택",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: settings.root || app.getPath("documents"),
    });
    if (r.canceled || !r.filePaths[0]) return false;
    openRoot(r.filePaths[0]);
    return true;
  });

  ipcMain.handle("rescan", () => {
    runScan();
  });

  ipcMain.handle("search", (_e, q) => search(q));

  ipcMain.handle("get-text", (_e, rel) => (index && index.files[rel] ? index.files[rel].text || "" : ""));

  ipcMain.handle("update-doc", (_e, rel, patch) => {
    const e = index && index.files[rel];
    if (!e) return null;
    for (const k of indexer.USER_FIELDS) {
      if (patch[k] === undefined) continue;
      const v = patch[k];
      if (v === "" || v === false || (Array.isArray(v) && !v.length)) delete e[k];
      else e[k] = v;
    }
    persistIndex();
    return docSummary(e);
  });

  ipcMain.handle("open-file", async (_e, rel) => {
    const err = await shell.openPath(fullPath(rel));
    return err || "";
  });

  ipcMain.handle("show-in-folder", (_e, rel) => {
    shell.showItemInFolder(fullPath(rel));
  });

  ipcMain.handle("open-root", async () => {
    if (settings.root) await shell.openPath(settings.root);
  });

  ipcMain.handle("save-settings", (_e, next) => {
    settings.partners = Array.isArray(next.partners) ? next.partners : [];
    settings.tagRules = Array.isArray(next.tagRules) ? next.tagRules : [];
    saveSettings();
    if (index) {
      indexer.reclassifyAll(index, classifyOptions());
      persistIndex();
    }
    send("state", state());
    return true;
  });

  ipcMain.handle("export-csv", async (_e, rels) => {
    const r = await dialog.showSaveDialog(win, {
      title: "문서 목록 내보내기",
      defaultPath: path.join(app.getPath("documents"), "문서목록.csv"),
      filters: [{ name: "CSV (엑셀에서 열기)", extensions: ["csv"] }],
    });
    if (r.canceled || !r.filePath) return false;
    const label = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.group ? `${c.group} · ${c.label}` : c.label]));
    const rows = [["파일 이름", "폴더", "분류", "태그", "수정일", "메모", "전체 경로"]];
    for (const rel of rels) {
      const e = index.files[rel];
      if (!e) continue;
      const p = indexer.nameParts(rel);
      const eff = indexer.effective(e);
      rows.push([p.base, p.dir, label[eff.category], eff.tags.join(", "), new Date(e.mtimeMs).toLocaleDateString("ko-KR"), e.note || "", path.join(index.root, ...rel.split("/"))]);
    }
    // 엑셀에서 한글이 깨지지 않도록 BOM 을 붙인다.
    fs.writeFileSync(r.filePath, "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n"));
    return true;
  });
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: "문서 보관함",
    icon: path.join(__dirname, "assets", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "app", "index.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      if (isWebUrl(url)) shell.openExternal(url);
    }
  });

  // 다른 프로그램에서 문서를 고치고 돌아오면 바뀐 것만 다시 읽는다.
  win.on("focus", () => {
    if (Date.now() - lastFocusScan > 30000) {
      lastFocusScan = Date.now();
      runScan();
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("com.jasonscho.docmanager");
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  settings = loadSettings();
  if (settings.root) index = indexer.loadIndex(userFile("index.json"), settings.root);
  registerIpc();
  createWindow();
  if (settings.root) {
    startWatching();
    lastFocusScan = Date.now();
    runScan();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
