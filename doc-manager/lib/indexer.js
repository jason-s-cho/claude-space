// 지정한 폴더를 훑어서 문서 목록(색인)을 만들고 JSON 파일에 저장한다.
// 크기·수정 시각이 그대로인 파일은 다시 읽지 않는다.
// 내가 직접 고친 분류·태그·메모는 자동 분류보다 우선하며, 파일 이름을 바꾸거나 옮겨도 따라간다.
const fs = require("fs");
const path = require("path");
const { extract, fileKind } = require("./extract");
const { classify, RENAMED, CLASSIFIER_VERSION } = require("./classify");
const { countTerms } = require("./keywords");

const INDEX_VERSION = 1;
const SKIP_DIRS = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", ".Trash"]);

function emptyIndex(root) {
  return { version: INDEX_VERSION, root, files: {}, classifierVersion: CLASSIFIER_VERSION };
}

// opts.anyRoot: 색인이 문서 폴더 안에 있을 때. 폴더를 옮겼거나 다른 PC(드라이브 문자가 다름)에서 열어도
// 파일 경로는 폴더 기준 상대 경로이므로 그대로 쓴다.
function loadIndex(file, root, opts = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && data.version === INDEX_VERSION && (data.root === root || opts.anyRoot) && data.files) {
      data.root = root;
      // 키워드 기능이 생기기 전에 만든 색인: 파일을 다시 읽지 않고 저장된 본문으로 센다.
      for (const e of Object.values(data.files)) {
        if (!e.terms) e.terms = countTerms([e.title, e.text].join("\n"));
        // 이름이 바뀐 분류 (예: 수요조사서 → 공고·수요조사)
        if (e.userCategory && RENAMED[e.userCategory]) e.userCategory = RENAMED[e.userCategory];
      }
      return data;
    }
  } catch {}
  return emptyIndex(root);
}

function saveIndex(file, index) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, file);
}

// 임시 파일(~$문서.docx 등)과 숨김 파일은 건너뛴다.
function isTempName(name) {
  return name.startsWith("~$") || name.startsWith(".~") || name.startsWith("._") || name.startsWith(".");
}

async function walk(root) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isTempName(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(full);
      } else if (e.isFile() && fileKind(e.name)) {
        try {
          const st = await fs.promises.stat(full);
          out.push({ full, rel: path.relative(root, full).split(path.sep).join("/"), size: st.size, mtimeMs: Math.round(st.mtimeMs), birthtimeMs: Math.round(st.birthtimeMs || st.mtimeMs) });
        } catch {}
      }
    }
  }
  await visit(root);
  return out;
}

function nameParts(rel) {
  const base = rel.split("/").pop();
  const ext = path.extname(base);
  return { base, name: base.slice(0, base.length - ext.length), ext: ext.toLowerCase().slice(1), dir: rel.split("/").slice(0, -1).join("/") };
}

function hasUserEdits(entry) {
  return entry.userCategory || (entry.userTags && entry.userTags.length) || (entry.hiddenTags && entry.hiddenTags.length) || entry.note || entry.starred;
}

const USER_FIELDS = ["userCategory", "userTags", "hiddenTags", "note", "starred"];

function reclassify(entry, options) {
  const p = nameParts(entry.rel);
  const c = classify({ name: p.name, dir: p.dir, text: entry.text, title: entry.title }, options);
  entry.autoCategory = c.category;
  entry.autoScore = c.score;
  entry.reasons = c.reasons;
  entry.autoTags = c.tags;
}

// 화면에 보여 줄 최종 분류·태그
function effective(entry) {
  const hidden = new Set(entry.hiddenTags || []);
  const tags = [...new Set([...(entry.autoTags || []).filter((t) => !hidden.has(t)), ...(entry.userTags || [])])];
  return { category: entry.userCategory || entry.autoCategory || "other", tags };
}

// 파일 하나를 읽어서 색인 항목을 만든다. f: { full, rel, size, mtimeMs, birthtimeMs }
async function buildEntry(f) {
  const x = await extract(f.full);
  return {
    rel: f.rel,
    size: f.size,
    mtimeMs: f.mtimeMs,
    birthtimeMs: f.birthtimeMs,
    kind: x.kind,
    title: x.title || "",
    author: x.author || "",
    pages: x.pages || 0,
    text: x.text,
    terms: countTerms([x.title, x.text].join("\n")),
    error: x.error,
    indexedAt: Date.now(),
  };
}

// 폴더 밖의 파일 하나를 색인에 바로 넣는다. (끌어다 놓은 파일)
async function addFile(index, full, options) {
  const st = await fs.promises.stat(full);
  const rel = path.relative(index.root, full).split(path.sep).join("/");
  const entry = await buildEntry({ full, rel, size: st.size, mtimeMs: Math.round(st.mtimeMs), birthtimeMs: Math.round(st.birthtimeMs || st.mtimeMs) });
  reclassify(entry, options);
  index.files[rel] = entry;
  return entry;
}

/**
 * 폴더를 다시 훑어 색인을 갱신한다.
 * onProgress({ done, total, current })
 * 결과: { added, updated, removed, index }
 */
async function scan(index, options, onProgress) {
  const root = index.root;
  const found = await walk(root);
  const seen = new Set(found.map((f) => f.rel));
  const old = index.files;

  // 사라진 파일 중 내가 고친 내용이 있는 것: 크기·수정 시각이 같은 새 파일로 옮겨졌다고 본다.
  const orphans = Object.values(old).filter((e) => !seen.has(e.rel) && hasUserEdits(e));

  const todo = found.filter((f) => {
    const e = old[f.rel];
    return !e || e.size !== f.size || e.mtimeMs !== f.mtimeMs;
  });

  let added = 0, updated = 0, done = 0;
  for (const f of todo) {
    if (onProgress) onProgress({ done, total: todo.length, current: f.rel });
    const prev = old[f.rel];
    const entry = await buildEntry(f);
    let source = prev;
    if (!source) {
      const i = orphans.findIndex((o) => o.size === f.size && o.mtimeMs === f.mtimeMs && nameParts(o.rel).ext === nameParts(f.rel).ext);
      if (i >= 0) source = orphans.splice(i, 1)[0];
    }
    if (source) for (const k of USER_FIELDS) if (source[k] !== undefined) entry[k] = source[k];
    reclassify(entry, options);
    old[f.rel] = entry;
    if (prev) updated++; else added++;
    done++;
    // 너무 오래 메인 스레드를 잡지 않도록 가끔 쉰다.
    if (done % 5 === 0) await new Promise((r) => setImmediate(r));
  }

  let removed = 0;
  for (const rel of Object.keys(old)) {
    // 훑는 도중에 새로 들어온 파일(끌어다 놓기)은 지우지 않는다.
    if (!seen.has(rel) && !fs.existsSync(path.join(root, ...rel.split("/")))) {
      delete old[rel];
      removed++;
    }
  }
  if (onProgress) onProgress({ done: todo.length, total: todo.length, current: "" });
  return { added, updated, removed, index };
}

// 분류 규칙(고객사 목록, 태그 규칙)이 바뀌었을 때 파일을 다시 읽지 않고 분류만 다시 한다.
function reclassifyAll(index, options) {
  for (const e of Object.values(index.files)) reclassify(e, options);
  index.classifierVersion = CLASSIFIER_VERSION;
}

// 분류 규칙이 바뀐 새 버전의 앱으로 처음 열었으면 모든 문서를 다시 분류한다. (파일은 다시 읽지 않음)
function upgradeIfNeeded(index, options) {
  if (index.classifierVersion === CLASSIFIER_VERSION) return false;
  reclassifyAll(index, options);
  return true;
}

module.exports = { upgradeIfNeeded, loadIndex, saveIndex, emptyIndex, scan, reclassifyAll, effective, nameParts, buildEntry, addFile, walk, isTempName, USER_FIELDS };
