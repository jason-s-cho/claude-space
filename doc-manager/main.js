const { app, BrowserWindow, Menu, shell, ipcMain, dialog, nativeTheme } = require("electron");
const fs = require("fs");
const path = require("path");
const indexer = require("./lib/indexer");
const { CATEGORIES, KEYWORDS, KEYWORD_GROUPS, TECH_TAGS, migrateOverrides } = require("./lib/classify");
const { docFrequency, topKeywords } = require("./lib/keywords");
const searchLib = require("./lib/search");
const { groupVersions, nextVersionName, uniqueVersionName } = require("./lib/versions");
const { importFiles, ensureCategoryFolders, expectedFolder, moveToFolder, removeLegacyFolders } = require("./lib/importer");
const { SUPPORTED } = require("./lib/extract");

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
const store = require("./lib/store");
const claudeConfig = require("./lib/claude-config");
const knowledge = require("./lib/knowledge");
const { readLog } = require("./lib/library");

// Claude 커넥터 실행 방법: 이 앱의 실행 파일을 Node 처럼 돌려 mcp/server.js 를 실행한다.
// (따로 Node 를 설치할 필요가 없다. 설치판에서는 app.asar 안의 파일을 그대로 읽는다)
function mcpEntry() {
  return {
    command: process.execPath,
    args: [path.join(app.getAppPath(), "mcp", "server.js")],
    env: { ELECTRON_RUN_AS_NODE: "1", DOCMANAGER_USERDATA: app.getPath("userData") },
  };
}

// 색인 파일: 보통 문서 폴더 안의 .docmanager/index.json, 폴더에 쓸 수 없으면 앱 데이터 폴더
let indexFile = null;
let indexInFolder = false;
// 다른 PC(클라우드 동기화)가 고친 것을 알아채기 위해 마지막으로 읽고 쓴 시각을 기억한다.
let indexDiskMtime = 0;
let folderSettingsMtime = 0;

const mtimeOf = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

const DEFAULT_SETTINGS = { root: "", partners: [], tagRules: [], keywordOverrides: {}, savedSearches: [], recentSearches: [], importLayout: "category", projects: [], techTags: true, theme: "system", aiExcludeCategories: [] };

function loadSettings() {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(userFile("settings.json"), "utf8")) };
    s.keywordOverrides = migrateOverrides(s.keywordOverrides);
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// PC 설정은 앱 데이터 폴더에, 분류 규칙(과제·고객사·태그 규칙·분류 키워드·저장한 검색)은 문서 폴더에도 저장한다.
function savePcSettings() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(userFile("settings.json"), JSON.stringify(settings, null, 2));
}

function saveSettings() {
  savePcSettings();
  if (settings.root && store.saveFolderSettings(settings.root, settings)) {
    folderSettingsMtime = mtimeOf(store.paths(settings.root).settings);
  }
}

// 문서 폴더의 분류 규칙을 읽어 지금 설정에 덮는다. 폴더에 아직 없으면 지금 설정을 폴더에 써 둔다.
function loadFolderSettings(root) {
  const { values, fromFolder } = store.loadFolderSettings(root, settings);
  Object.assign(settings, values);
  settings.keywordOverrides = migrateOverrides(settings.keywordOverrides);
  if (fromFolder) folderSettingsMtime = mtimeOf(store.paths(root).settings);
  else saveSettings();
}

// 문서 폴더를 연다: 예전 색인 옮기기 → 분류 규칙 읽기 → 색인 읽기
function loadRoot(root) {
  if (store.migrateLegacyIndex(root, userFile("index.json"))) console.log("색인을 문서 폴더로 옮김");
  loadFolderSettings(root);
  const loc = store.indexLocation(root, userFile("index.json"));
  indexFile = loc.file;
  indexInFolder = loc.inFolder;
  index = indexer.loadIndex(indexFile, root, { anyRoot: indexInFolder });
  indexDiskMtime = mtimeOf(indexFile);
  if (indexer.upgradeIfNeeded(index, classifyOptions())) persistIndex();
  keywordCache = versionCache = null;
}

// 다른 PC가 같은 문서 폴더의 색인이나 분류 규칙을 고쳤으면 다시 읽는다. (창으로 돌아올 때·다시 훑기 전에)
function syncFromDisk() {
  if (!index || !settings.root) return false;
  let changed = false;
  const sFile = store.paths(settings.root).settings;
  const sMtime = mtimeOf(sFile);
  if (sMtime && sMtime !== folderSettingsMtime) {
    loadFolderSettings(settings.root);
    changed = true;
  }
  const iMtime = mtimeOf(indexFile);
  if (iMtime && iMtime !== indexDiskMtime) {
    index = indexer.loadIndex(indexFile, settings.root, { anyRoot: indexInFolder });
    indexDiskMtime = iMtime;
    changed = true;
  }
  if (changed) {
    indexer.reclassifyAll(index, classifyOptions());
    keywordCache = versionCache = null;
  }
  return changed;
}

function classifyOptions() {
  return {
    partners: settings.partners,
    projects: settings.projects,
    tagRules: settings.tagRules,
    keywordOverrides: settings.keywordOverrides,
    techTags: settings.techTags !== false,
  };
}

function persistIndex() {
  if (!index || !index.root || !indexFile) return;
  try {
    indexer.saveIndex(indexFile, index);
    indexDiskMtime = mtimeOf(indexFile);
  } catch (e) {
    send("scan-error", "색인을 저장하지 못했습니다: " + ((e && e.message) || e));
  }
}

// 문서마다 핵심 키워드. 전체 문서와 비교해야 하므로 색인이 바뀔 때마다 다시 계산한다.
let keywordCache = null; // Map(rel → 키워드), 색인이 바뀌면 null 로 비운다.
function keywordMap() {
  if (!keywordCache) {
    const entries = index ? Object.values(index.files) : [];
    const df = docFrequency(entries.map((e) => e.terms));
    keywordCache = new Map();
    for (const e of entries) keywordCache.set(e.rel, topKeywords(e.terms, df, entries.length));
  }
  return keywordCache;
}
const keywordsOf = (rel) => keywordMap().get(rel) || [];

// 같은 문서의 여러 버전 묶음. 키워드와 같이 색인이 바뀌면 다시 만든다.
let versionCache = null;
function versionMap() {
  if (!versionCache) {
    const docs = index ? Object.values(index.files).map((e) => ({ rel: e.rel, base: e.rel.split("/").pop(), mtimeMs: e.mtimeMs })) : [];
    versionCache = groupVersions(docs);
  }
  return versionCache;
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
    protectedText: !!e.protectedText,
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
    keywords: keywordsOf(e.rel),
    versions: versionMap().get(e.rel) || null, // { size, latest, order }
    // 분류에 맞는 폴더. 지금 폴더와 다르면 화면에서 '옮기기' 버튼을 보여 준다.
    expectedDir: settings.importLayout === "root" ? "" : expectedFolder(eff.category, eff.tags, settings.partners, settings.projects),
  };
}

function state() {
  return {
    root: settings.root,
    settings,
    appVersion: app.getVersion(),
    indexInFolder,
    platform: process.platform,
    categories: CATEGORIES,
    keywordGroups: KEYWORD_GROUPS,
    defaultKeywords: KEYWORDS,
    techTags: TECH_TAGS.map(([tag, words]) => ({ tag, words })),
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
  // 켤 때 없던 폴더가 다시 보이면(외장 드라이브 연결 등) 그 폴더의 색인부터 읽는다.
  if (!indexFile) {
    loadRoot(index.root);
    prepareFolders();
    startWatching();
  }
  scanning = true;
  syncFromDisk();
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
    // 바뀐 게 있을 때만 저장한다. (괜히 쓰면 클라우드 동기화가 계속 일어난다)
    if (r.added || r.updated || r.removed) {
      persistIndex();
      keywordCache = versionCache = null;
    }
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
    watcher = fs.watch(settings.root, { recursive: true }, (_event, filename) => {
      // 이 앱이 .docmanager 에 쓴 것 때문에 다시 훑지 않는다
      if (store.isOwnFile(filename)) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(runScan, 2500);
    });
    watcher.on("error", () => {});
  } catch {
    // 감시가 안 되는 환경이면 창으로 돌아올 때마다 다시 훑는 것으로 대신한다.
    watcher = null;
  }
}

// '분류별 하위 폴더' 방식이면 문서 폴더 안에 분류 폴더를 만들어 둔다.
function prepareFolders() {
  if (settings.root && fs.existsSync(settings.root)) removeLegacyFolders(settings.root);
  if (settings.root && settings.importLayout !== "root" && fs.existsSync(settings.root)) {
    return ensureCategoryFolders(settings.root, settings.partners, settings.projects);
  }
  return 0;
}

function openRoot(root) {
  settings.root = root;
  // 새 폴더의 분류 규칙을 읽기 전이므로 PC 설정만 저장한다. (지금 규칙으로 그 폴더의 규칙을 덮어쓰지 않도록)
  savePcSettings();
  if (root) loadRoot(root);
  else index = null;
  prepareFolders();
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

// 검색용으로 본문을 소문자·띄어쓰기 없이 만들어 둔다. (파일이 바뀔 때만 다시 만든다)
const textCache = new Map();
function searchView(e) {
  let c = textCache.get(e.rel);
  if (!c || c.stamp !== e.indexedAt) {
    c = { stamp: e.indexedAt, textNs: (e.text || "").toLowerCase().replace(/\s+/g, "") };
    textCache.set(e.rel, c);
  }
  const p = indexer.nameParts(e.rel);
  const eff = indexer.effective(e);
  const cat = CATEGORIES.find((x) => x.id === eff.category) || {};
  const years = new Set(eff.tags.filter((t) => /^20\d{2}$/.test(t)));
  years.add(String(new Date(e.mtimeMs).getFullYear()));
  return {
    name: p.base,
    dir: p.dir,
    title: e.title || "",
    note: e.note || "",
    tags: eff.tags,
    keywords: keywordsOf(e.rel),
    kind: e.kind,
    ext: p.ext,
    years: [...years],
    catText: `${cat.group || ""} ${cat.label || ""}`,
    textNs: c.textNs,
  };
}

function search(query) {
  const parsed = searchLib.parseQuery(query);
  if (!index || searchLib.isEmpty(parsed)) return { highlight: [], results: [] };
  const results = [];
  for (const e of Object.values(index.files)) {
    const score = searchLib.matchView(searchView(e), parsed);
    if (score > 0) results.push({ rel: e.rel, score, snippet: searchLib.snippet(e.text || "", parsed.highlight) });
  }
  for (const rel of textCache.keys()) if (!index.files[rel]) textCache.delete(rel);
  return { highlight: parsed.highlight, results };
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

  // 끌어다 놓은 파일(또는 '문서 넣기'로 고른 파일)을 문서 폴더에 복사하고 분류한다.
  // 넣는 도중에 또 넣으면 앞의 것이 끝난 뒤 이어서 한다.
  let importChain = Promise.resolve();
  function doImport(paths) {
    const run = async () => {
      if (!index || !index.root) return { imported: [], existing: [], skipped: [], error: "먼저 문서 폴더를 골라 주세요." };
      let lastSend = 0;
      const r = await importFiles(index, paths, {
        layout: settings.importLayout,
        options: classifyOptions(),
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastSend > 120 || p.done === p.total) {
            lastSend = now;
            send("import-progress", p);
          }
        },
      });
      persistIndex();
      keywordCache = versionCache = null;
      send("state", state());
      return r;
    };
    const job = importChain.then(run, run);
    importChain = job.catch(() => {});
    return job;
  }

  ipcMain.handle("import-files", (_e, paths) => doImport(Array.isArray(paths) ? paths.filter((p) => typeof p === "string" && p) : []));

  // kind: "files"(여러 개 고르기) | "folder"(폴더째, 안의 문서 모두)
  ipcMain.handle("pick-and-import", async (_e, kind) => {
    const folder = kind === "folder";
    const r = await dialog.showOpenDialog(win, folder
      ? { title: "문서 폴더에 넣을 폴더 고르기 (안의 문서를 모두 넣습니다)", properties: ["openDirectory", "multiSelections"] }
      : {
          title: "문서 폴더에 넣을 파일 고르기 (Ctrl·Shift 로 여러 개)",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "문서", extensions: Object.keys(SUPPORTED).map((x) => x.slice(1)) }],
        });
    if (r.canceled || !r.filePaths.length) return null;
    return doImport(r.filePaths);
  });

  // 새 버전으로 고치기: 같은 폴더에 다음 버전 이름으로 복사해서 연다. 원본은 건드리지 않는다.
  // 분류·태그는 이어받고, 메모·즐겨찾기는 그 버전에만 해당하므로 넘기지 않는다.
  ipcMain.handle("new-version", async (_e, rel) => {
    const e = index && index.files[rel];
    if (!e) return { error: "알 수 없는 파일" };
    try {
      const src = fullPath(rel);
      const dir = path.dirname(src);
      const v = versionMap().get(rel);
      const siblings = v ? v.order.map((r) => r.split("/").pop()) : [];
      const name = uniqueVersionName(nextVersionName(path.basename(src), siblings), (n) => fs.existsSync(path.join(dir, n)));
      const dest = path.join(dir, name);
      await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      const now = new Date();
      await fs.promises.utimes(dest, now, now); // 윈도우는 복사해도 원래 수정 시각이 남으므로 지금으로
      const entry = await indexer.addFile(index, dest, classifyOptions());
      for (const k of ["userCategory", "userTags", "hiddenTags"]) if (e[k] !== undefined) entry[k] = JSON.parse(JSON.stringify(e[k]));
      persistIndex();
      keywordCache = versionCache = null;
      send("state", state());
      const err = await shell.openPath(dest);
      return { rel: entry.rel, openError: err || "" };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  });

  // ---- Claude 연결 ----
  ipcMain.handle("claude-status", () => {
    const entry = mcpEntry();
    return { targets: claudeConfig.status(entry), claudeCode: claudeConfig.claudeCodeCommand(entry) };
  });
  ipcMain.handle("claude-connect", () => {
    try {
      return { done: claudeConfig.connect(mcpEntry()) };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("claude-disconnect", () => {
    try {
      return { done: claudeConfig.disconnect() };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("claude-test", async () => {
    const entry = mcpEntry();
    const test = await claudeConfig.selfTest(entry);
    return { test, logs: claudeConfig.claudeLogs(), targets: claudeConfig.status(entry) };
  });
  // ---- 회사 지식 카드 ----
  ipcMain.handle("knowledge-get", () => {
    if (!settings.root) return { error: "문서 폴더를 먼저 골라 주세요." };
    const k = knowledge.read(settings.root);
    return { ...k, template: knowledge.TEMPLATE, rel: `${knowledge.DIR_NAME}/${knowledge.CARD_NAME}` };
  });
  ipcMain.handle("knowledge-save", (_e, content) => {
    try {
      if (!settings.root) throw new Error("문서 폴더를 먼저 골라 주세요.");
      return knowledge.save(settings.root, content);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("knowledge-open", async () => {
    try {
      if (!settings.root) throw new Error("문서 폴더를 먼저 골라 주세요.");
      const k = knowledge.read(settings.root);
      if (!k.exists) knowledge.save(settings.root, knowledge.TEMPLATE);
      shell.showItemInFolder(k.path);
      return {};
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("ai-log", () => (settings.root ? readLog(settings.root, 40) : []));

  ipcMain.handle("move-to-category", async (_e, rel) => {
    const e = index && index.files[rel];
    if (!e) return { error: "알 수 없는 파일" };
    const eff = indexer.effective(e);
    try {
      const newRel = await moveToFolder(index, rel, expectedFolder(eff.category, eff.tags, settings.partners, settings.projects));
      persistIndex();
      keywordCache = versionCache = null;
      send("state", state());
      return { rel: newRel };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
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

  // 저장한 검색 · 최근 검색 (분류에는 영향 없음)
  ipcMain.handle("save-searches", (_e, next) => {
    if (Array.isArray(next.savedSearches)) settings.savedSearches = next.savedSearches.slice(0, 50);
    if (Array.isArray(next.recentSearches)) settings.recentSearches = next.recentSearches.slice(0, 15);
    saveSettings();
    return true;
  });

  ipcMain.handle("save-settings", (_e, next) => {
    if (Array.isArray(next.partners)) settings.partners = next.partners;
    if (Array.isArray(next.tagRules)) settings.tagRules = next.tagRules;
    if (Array.isArray(next.projects)) settings.projects = next.projects;
    if (typeof next.techTags === "boolean") settings.techTags = next.techTags;
    if (Array.isArray(next.aiExcludeCategories)) settings.aiExcludeCategories = next.aiExcludeCategories.filter((x) => typeof x === "string");
    if (["system", "light", "dark"].includes(next.theme)) {
      settings.theme = next.theme;
      applyTheme();
    }
    if (next.keywordOverrides && typeof next.keywordOverrides === "object") settings.keywordOverrides = next.keywordOverrides;
    if (next.importLayout === "category" || next.importLayout === "root") settings.importLayout = next.importLayout;
    saveSettings();
    prepareFolders();
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

// 제목 표시줄을 없애고 화면이 창 맨 위까지 오게 한다. 창 단추(최소화·닫기)는 운영체제 것을 위에 겹쳐 쓴다.
const TITLEBAR_HEIGHT = 52;
function overlayColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: "#00000000", symbolColor: "#c9ccd6", height: TITLEBAR_HEIGHT }
    : { color: "#00000000", symbolColor: "#3b3f4a", height: TITLEBAR_HEIGHT };
}

function applyTheme() {
  nativeTheme.themeSource = ["light", "dark"].includes(settings.theme) ? settings.theme : "system";
}

function createWindow() {
  const mac = process.platform === "darwin";
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 860,
    minHeight: 580,
    title: "문서 보관함",
    icon: path.join(__dirname, "assets", "icon.png"),
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    ...(mac ? { trafficLightPosition: { x: 18, y: 18 } } : { titleBarOverlay: overlayColors() }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111216" : "#f7f7f9",
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
  applyTheme();
  nativeTheme.on("updated", () => {
    if (win && process.platform !== "darwin") {
      try {
        win.setTitleBarOverlay(overlayColors());
      } catch {}
    }
  });
  if (settings.root && fs.existsSync(settings.root)) loadRoot(settings.root);
  // 폴더가 없어졌으면(외장 드라이브를 뺐거나 이름이 바뀜) 빈 목록으로 열고 다시 훑을 때 알려 준다.
  else if (settings.root) index = indexer.emptyIndex(settings.root);
  registerIpc();
  createWindow();
  if (settings.root) {
    prepareFolders();
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
