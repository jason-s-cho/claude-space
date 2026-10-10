const { app, BrowserWindow, Menu, shell, ipcMain, dialog, nativeTheme, net } = require("electron");
const fs = require("fs");
const path = require("path");
const indexer = require("./lib/indexer");
const { CATEGORIES, KEYWORDS, KEYWORD_GROUPS, TECH_TAGS, migrateOverrides } = require("./lib/classify");
const { docFrequency, topKeywords } = require("./lib/keywords");
const searchLib = require("./lib/search");
const { groupVersions, nextVersionName, uniqueVersionName } = require("./lib/versions");
const { importFiles, safeName, ensureCategoryFolders, expectedFolder, moveToFolder, moveManyToFolders, isInPlace, removeLegacyFolders } = require("./lib/importer");
const { SUPPORTED, extract } = require("./lib/extract");
const { compareTexts } = require("./lib/diff");

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
const duplicates = require("./lib/duplicates");
const { convert, targetsFor } = require("./lib/convert");
const updates = require("./lib/updates");
const appsLib = require("./lib/applications");
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
let textFile = null; // 이 PC의 본문 캐시 (store.textCacheFile)
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

const DEFAULT_SETTINGS = { root: "", partners: [], tagRules: [], keywordOverrides: {}, savedSearches: [], recentSearches: [], importLayout: "category", projects: [], techTags: true, theme: "system", aiExcludeCategories: [], checkUpdates: true };

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

// ---- 지원 건 (.docmanager/applications.json) ----
let appsData = appsLib.empty();
let appsMtime = 0;
function loadApps(root) {
  appsData = appsLib.load(root);
  appsMtime = mtimeOf(appsLib.fileOf(root));
}
// 화면에 보낼 지원 건: 지금 단계(진행 중·탈락·선정)를 붙여서
function appsState() {
  return { templates: appsData.templates, statuses: appsLib.STATUSES, refKinds: appsLib.REF_KINDS, programs: appsData.programs, items: appsData.items.map((a) => ({ ...a, progress: appsLib.progress(a) })) };
}

// 문서 폴더를 연다: 예전 색인 옮기기 → 분류 규칙 읽기 → 색인 읽기
function loadRoot(root) {
  dupGroups = [];
  if (store.migrateLegacyIndex(root, userFile("index.json"))) console.log("색인을 문서 폴더로 옮김");
  loadFolderSettings(root);
  const loc = store.indexLocation(root, userFile("index.json"));
  indexFile = loc.file;
  indexInFolder = loc.inFolder;
  loadApps(root);
  textFile = store.textCacheFile(app.getPath("userData"), root);
  index = indexer.loadIndex(indexFile, root, { anyRoot: indexInFolder, textFile });
  indexDiskMtime = mtimeOf(indexFile);
  warmSearch();
  // 본문이 들어 있던 예전 색인이면 지금 바로 작은 색인 + 이 PC의 본문 캐시로 나눠 쓴다
  if (indexer.upgradeIfNeeded(index, classifyOptions()) || index.textDirty) persistIndex();
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
  const aMtime = mtimeOf(appsLib.fileOf(settings.root));
  if (aMtime !== appsMtime) {
    loadApps(settings.root); // Claude 커넥터나 다른 PC가 지원 건을 고쳤다
    changed = true;
  }
  const iMtime = mtimeOf(indexFile);
  if (iMtime && iMtime !== indexDiskMtime) {
    index = indexer.loadIndex(indexFile, settings.root, { anyRoot: indexInFolder, textSource: indexer.textSourceOf(index) });
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
    indexer.saveIndex(indexFile, index, { textFile });
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

function expectedDirOf(e) {
  if (settings.importLayout === "root") return "";
  const eff = indexer.effective(e);
  return expectedFolder(eff.category, eff.tags, settings.partners, settings.projects);
}

// 화면에 보내는 문서 정보. 본문 전체는 보내지 않고 앞부분만 보낸다.
function docSummary(e) {
  const p = indexer.nameParts(e.rel);
  const eff = indexer.effective(e);
  // 분류에 맞는 폴더. 지금 폴더가 그 폴더(또는 그 아래)가 아니면 화면에서 '옮기기'를 보여 준다.
  const expectedDir = expectedDirOf(e);
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
    // 버전 묶음: 묶음 목록(order)은 state.families 에 한 번만 담고, 문서에는 묶음 이름만 (문서마다 목록을 되풀이하면 수 MB 가 된다)
    versions: (() => {
      const v = versionMap().get(e.rel);
      return v ? { key: v.key, size: v.size, latest: v.latest } : null;
    })(),
    expectedDir,
    // 이 PC의 한글·워드로 바꿀 수 있는 형식 (윈도우에서만)
    convertTo: process.platform === "win32" ? targetsFor("." + p.ext) : [],
    misplaced: !isInPlace(p.dir, expectedDir),
  };
}

// ---- 중복 파일 (내용이 완전히 같은 파일) ----
let dupGroups = [];
let dupBusy = false;
function currentDupGroups() {
  if (!index) return [];
  return dupGroups.map((g) => g.filter((r) => index.files[r])).filter((g) => g.length > 1);
}
function inPlaceRel(rel) {
  const e = index.files[rel];
  return !!e && isInPlace(indexer.nameParts(rel).dir, expectedDirOf(e));
}
function versionRank(rel) {
  const v = versionMap().get(rel);
  const i = v ? v.order.indexOf(rel) : -1;
  return i < 0 ? Infinity : i;
}
async function refreshDuplicates() {
  if (!index || !index.root || dupBusy) return;
  dupBusy = true;
  try {
    const r = await duplicates.findDuplicates(index);
    if (r.hashed) persistIndex(); // 계산한 지문을 기억해 둔다
    dupGroups = r.groups;
    send("state", state());
  } catch {
  } finally {
    dupBusy = false;
  }
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
    applications: appsState(),
    families: (() => {
      const out = {};
      for (const v of versionMap().values()) out[v.key] = v.order;
      return out;
    })(),
    duplicates: currentDupGroups().map((rels) => ({ rels, keep: duplicates.suggestKeep(index, rels, inPlaceRel, versionRank) })),
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
  } else {
    refreshDuplicates();
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
// 띄어쓰기를 뺀 소문자 본문 (검색용). replace(/\s+/g) 로 만든 문자열은 includes 가 수십 배 느려서 split/join 으로 만든다.
const squash = (t) => (t ? t.toLowerCase().split(/\s+/).join("") : "");
function textOf(e) {
  let c = textCache.get(e.rel);
  if (!c || c.stamp !== e.indexedAt) {
    c = { stamp: e.indexedAt, textNs: squash(e.text) };
    textCache.set(e.rel, c);
  }
  return c;
}

// 앱을 켠 뒤 쉬는 틈에 검색용 본문을 미리 만들어 둔다 (첫 검색이 느리지 않게)
let warmTimer = null;
function warmSearch() {
  clearTimeout(warmTimer);
  const rels = index ? Object.keys(index.files) : [];
  let i = 0;
  const step = () => {
    const end = Math.min(rels.length, i + 40);
    for (; i < end; i++) if (index && index.files[rels[i]]) textOf(index.files[rels[i]]);
    if (i < rels.length) warmTimer = setTimeout(step, 0);
  };
  warmTimer = setTimeout(step, 1500);
}

function searchView(e) {
  const c = textOf(e);
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
    if (score > 0) results.push({ rel: e.rel, score });
  }
  for (const rel of textCache.keys()) if (!index.files[rel]) textCache.delete(rel);
  // 본문 미리보기는 점수가 높은 앞쪽 결과만 만든다 (문서가 많을 때 느려지지 않게)
  results.sort((a, b) => b.score - a.score);
  for (const r of results.slice(0, 300)) r.snippet = searchLib.snippet(index.files[r.rel].text || "", parsed.highlight);
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
  function doImport(paths, extra = {}) {
    const run = async () => {
      if (!index || !index.root) return { imported: [], existing: [], skipped: [], error: "먼저 문서 폴더를 골라 주세요." };
      let lastSend = 0;
      const r = await importFiles(index, paths, {
        layout: settings.importLayout,
        options: classifyOptions(),
        ...extra,
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
  // 문서 지우기: 한 번 더 묻고 휴지통으로 보낸다 (휴지통에서 되살릴 수 있다). Claude 커넥터에는 이 기능이 없다.
  ipcMain.handle("delete-doc", async (_e, rel) => {
    try {
      const full = fullPath(rel);
      const name = path.basename(full);
      const r = await dialog.showMessageBox(win, {
        type: "warning",
        buttons: ["휴지통으로 보내기", "취소"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: "문서 지우기",
        message: `'${name}'을(를) 지울까요?`,
        detail: `${path.dirname(rel) === "." ? "문서 폴더" : path.dirname(rel)} 폴더에서 휴지통으로 옮깁니다. 휴지통에서 되살릴 수 있지만, 이 앱에서 붙인 태그·메모·직접 고른 분류는 사라집니다.`,
      });
      if (r.response !== 0) return { cancelled: true };
      await shell.trashItem(full);
      delete index.files[rel];
      persistIndex();
      keywordCache = versionCache = null;
      send("state", state());
      return { deleted: rel };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  });

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
      if (appsLib.renameDocs(settings.root, [{ from: rel, to: newRel }])) loadApps(settings.root);
      keywordCache = versionCache = null;
      send("state", state());
      return { rel: newRel };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  });

  // ---- 지원 건 ----
  ipcMain.handle("apps-op", (_e, op) => {
    try {
      if (!settings.root) throw new Error("문서 폴더를 먼저 골라 주세요.");
      const r = appsLib.update(settings.root, op);
      loadApps(settings.root);
      send("state", state());
      return { id: r.id };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  });

  // 사업 자료(공고문·RFP 등) 넣기: 파일을 '국가과제·지원사업/(과제)/1 공고·수요조사/사업명' 폴더에 넣고 바로 연결한다.
  // target: { program } (사업 전체) 또는 { id } (지원 건 하나), kind: 자료 종류, paths: 끌어다 놓은 파일 (없으면 고르는 창)
  ipcMain.handle("apps-import-refs", async (_e, target, kind, paths) => {
    try {
      if (!settings.root || !index) throw new Error("문서 폴더를 먼저 골라 주세요.");
      target = target || {};
      let program = target.program;
      if (target.id) {
        const a = appsLib.load(settings.root).items.find((x) => x.id === target.id);
        if (!a) throw new Error("없는 지원 건입니다");
        program = a.program;
      }
      if (!Array.isArray(paths) || !paths.length) {
        const r = await dialog.showOpenDialog(win, {
          title: `${program || "지원 건"} 자료 넣기 (${kind || "참고 자료"}) · Ctrl·Shift 로 여러 개`,
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "문서", extensions: Object.keys(SUPPORTED).map((x) => x.slice(1)) }],
        });
        if (r.canceled || !r.filePaths.length) return { cancelled: true };
        paths = r.filePaths;
      }
      const base = expectedFolder("gov_notice", [], settings.partners, settings.projects);
      const folder = program ? `${base}/${safeName(program)}` : base;
      const r = await doImport(paths.filter((p) => typeof p === "string" && p), { folder, category: "gov_notice" });
      if (r.error) throw new Error(r.error);
      const rels = [...r.imported.map((x) => x.rel), ...r.existing.map((x) => x.rel)];
      for (const rel of rels) appsLib.update(settings.root, { type: "ref_link", ...(target.id ? { id: target.id } : { program }), rel, kind });
      if (rels.length) {
        loadApps(settings.root);
        persistIndex();
        send("state", state());
      }
      return { linked: rels.length, folder, skipped: r.skipped };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  });

  // ---- 새 버전 ----
  ipcMain.handle("check-update", () => runUpdateCheck(true));
  ipcMain.handle("open-update", (_e, url) => {
    // 이 앱의 GitHub 릴리스 주소만 연다
    if (typeof url === "string" && url.startsWith("https://github.com/jason-s-cho/claude-space/")) shell.openExternal(url);
  });

  // 다른 형식으로 저장 (한글·워드 이용). 한 번에 하나씩.
  let convertQueue = Promise.resolve();
  ipcMain.handle("convert-doc", (_e, rel, to) => {
    const job = convertQueue.then(async () => {
      try {
        const r = await convert(fullPath(rel), to);
        const entry = await indexer.addFile(index, r.output, classifyOptions());
        persistIndex();
        keywordCache = versionCache = null;
        send("state", state());
        return { rel: entry.rel, app: r.app };
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    });
    convertQueue = job.catch(() => {});
    return job;
  });

  // 중복 정리: 묶음마다 남길 파일 하나를 두고 나머지를 휴지통으로. 지우기 직전에 내용이 정말 같은지 다시 확인한다.
  ipcMain.handle("trash-duplicates", async (_e, plan) => {
    const trashed = [], failed = [];
    if (!index || !Array.isArray(plan)) return { trashed, failed };
    const groups = currentDupGroups();
    for (const { keep, remove } of plan) {
      const g = groups.find((x) => x.includes(keep));
      if (!g || !Array.isArray(remove)) continue;
      let keepHash;
      try {
        keepHash = await duplicates.hashFile(fullPath(keep));
      } catch (err) {
        for (const r of remove) failed.push({ rel: r, error: "남길 파일을 읽을 수 없습니다" });
        continue;
      }
      for (const rel of remove) {
        try {
          if (rel === keep || !g.includes(rel)) throw new Error("같은 묶음의 파일이 아닙니다");
          const full = fullPath(rel);
          if ((await duplicates.hashFile(full)) !== keepHash) throw new Error("내용이 달라졌습니다");
          duplicates.mergeInto(index.files[keep], [index.files[rel]]);
          await shell.trashItem(full);
          delete index.files[rel];
          trashed.push(rel);
        } catch (err) {
          failed.push({ rel, error: String((err && err.message) || err) });
        }
      }
    }
    if (trashed.length) {
      persistIndex();
      keywordCache = versionCache = null;
      send("state", state());
    }
    return { trashed, failed };
  });

  // 제자리가 아닌 문서 여러 개를 한꺼번에 분류 폴더로 옮긴다.
  ipcMain.handle("move-many", async (_e, rels) => {
    if (!index || !Array.isArray(rels)) return { moved: [], failed: [] };
    const r = await moveManyToFolders(index, rels, expectedDirOf);
    if (r.moved.length) {
      persistIndex();
      if (appsLib.renameDocs(settings.root, r.moved)) loadApps(settings.root);
      keywordCache = versionCache = null;
      send("state", state());
    }
    return r;
  });

  ipcMain.handle("rescan", () => {
    runScan();
  });

  ipcMain.handle("search", (_e, q) => search(q));

  // 두 문서(보통 같은 문서의 두 버전) 본문 비교. 앞이 이전, 뒤가 나중.
  ipcMain.handle("compare-docs", async (_e, relA, relB) => {
    try {
      const read = async (rel) => {
        const x = await extract(fullPath(rel), { maxText: 400000 });
        if (x.protected) throw new Error(`${rel.split("/").pop()}: 암호·배포용 문서라 본문을 다 읽을 수 없습니다`);
        return x.text || "";
      };
      const [ta, tb] = await Promise.all([read(relA), read(relB)]);
      if (!ta.trim() && !tb.trim()) throw new Error("두 문서 모두 본문 글자를 읽을 수 없습니다 (스캔 PDF·옛 형식 등)");
      return compareTexts(ta, tb);
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  });

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
    if (typeof next.checkUpdates === "boolean") settings.checkUpdates = next.checkUpdates;
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

// GitHub 릴리스에서 새 버전 확인. 켠 뒤 잠시 있다가 한 번, 그 뒤로 6시간마다. (개발 중인 앱은 자동으로 확인하지 않는다)
let lastUpdate = null;
async function runUpdateCheck(manual) {
  if (!manual && (!app.isPackaged || settings.checkUpdates === false)) return null;
  const r = await updates.checkForUpdate(app.getVersion(), {
    fetchJson: async (url) => {
      const res = await net.fetch(url, { headers: { "User-Agent": "doc-manager", Accept: "application/vnd.github+json" } });
      if (!res.ok) throw new Error(`GitHub 응답 ${res.status}`);
      return res.json();
    },
  });
  lastUpdate = r;
  if (r.available) send("update-available", r);
  return r;
}

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
  setTimeout(() => runUpdateCheck(false), 15000);
  setInterval(() => runUpdateCheck(false), 6 * 3600 * 1000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
