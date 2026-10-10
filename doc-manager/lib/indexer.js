// 지정한 폴더를 훑어서 문서 목록(색인)을 만들고 JSON 파일에 저장한다.
// 크기·수정 시각이 그대로인 파일은 다시 읽지 않는다.
// 내가 직접 고친 분류·태그·메모는 자동 분류보다 우선하며, 파일 이름을 바꾸거나 옮겨도 따라간다.
const fs = require("fs");
const path = require("path");
const { extract, fileKind } = require("./extract");
const { classify, RENAMED, CLASSIFIER_VERSION } = require("./classify");
const { countTerms } = require("./keywords");

const INDEX_VERSION = 1;
// 본문 읽는 방법이 좋아지면 올린다. 이보다 낮은 버전으로 읽은 파일은 한 번 다시 읽는다.
//   2: .hwp 본문 읽기
const EXTRACT_VERSION = 2;
const REREAD_EXTS = { 2: [".hwp"] };
const SKIP_DIRS = new Set(["Claude 지식", "node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", ".Trash"]);

function emptyIndex(root) {
  return { version: INDEX_VERSION, root, files: {}, classifierVersion: CLASSIFIER_VERSION };
}

// ---- 본문 캐시 ----
// 문서 본문(text)과 낱말 수(terms)는 파일에서 언제든 다시 뽑을 수 있으므로, 문서 폴더(구글 드라이브 등으로 동기화되는)의
// 색인에는 넣지 않고 이 PC의 앱 데이터 폴더에 따로 둔다. 그래서 태그 하나를 고쳐도 작은 색인만 다시 쓴다.
// 다른 PC에서 처음 열면 캐시가 없으므로 본문만 다시 읽는다 (분류·태그·메모는 색인에 있어 그대로).
const TEXT_FIELDS = ["text", "terms"];
const stampOf = (e) => `${e.size}:${e.mtimeMs}`;

function readTextCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && data.version === 1 && data.files) return data.files;
  } catch {}
  return {};
}

// opts.anyRoot: 색인이 문서 폴더 안에 있을 때. 폴더를 옮겼거나 다른 PC(드라이브 문자가 다름)에서 열어도
// 파일 경로는 폴더 기준 상대 경로이므로 그대로 쓴다.
// opts.textFile: 본문 캐시 파일 / opts.textSource: 이미 메모리에 있는 본문 (rel → { s, text, terms }), 있으면 파일 대신 쓴다
function loadIndex(file, root, opts = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && data.version === INDEX_VERSION && (data.root === root || opts.anyRoot) && data.files) {
      data.root = root;
      const cache = opts.textSource || (opts.textFile ? readTextCache(opts.textFile) : null);
      for (const e of Object.values(data.files)) {
        if (e.text === undefined && cache) {
          const c = cache[e.rel];
          if (c && c.s === stampOf(e)) {
            e.text = c.text;
            e.terms = c.terms;
          } else e.needsText = true; // 다음에 훑을 때 본문만 다시 읽는다
        } else if (e.text !== undefined && opts.textFile) data.textDirty = true; // 본문이 들어 있던 예전 색인 → 캐시로 옮긴다
        // 키워드 기능이 생기기 전에 만든 색인: 파일을 다시 읽지 않고 저장된 본문으로 센다.
        if (!e.terms) e.terms = countTerms([e.title, e.text || ""].join("\n"));
        // 이름이 바뀐 분류 (예: 수요조사서 → 공고·수요조사)
        if (e.userCategory && RENAMED[e.userCategory]) e.userCategory = RENAMED[e.userCategory];
        // 예전에 본문을 못 읽었던 형식(.hwp 등)은 다음에 훑을 때 다시 읽게 한다. (직접 고친 내용은 그대로)
        const ext = path.extname(e.rel).toLowerCase();
        for (let v = (e.extractVersion || 1) + 1; v <= EXTRACT_VERSION; v++) {
          if ((REREAD_EXTS[v] || []).includes(ext)) e.mtimeMs = -1;
        }
      }
      return data;
    }
  } catch {}
  return emptyIndex(root);
}

// opts.textFile 을 주면 본문은 그 캐시 파일에 (바뀌었을 때만), 색인 파일에는 나머지만 쓴다.
function saveIndex(file, index, opts = {}) {
  const write = (f, data) => {
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, f);
  };
  if (!opts.textFile) return write(file, index);
  const slim = { ...index, files: {} };
  delete slim.textDirty;
  const texts = {};
  for (const [rel, e] of Object.entries(index.files)) {
    const o = {};
    for (const k of Object.keys(e)) if (!TEXT_FIELDS.includes(k) && k !== "needsText") o[k] = e[k];
    slim.files[rel] = o;
    if (e.text !== undefined) texts[rel] = { s: stampOf(e), text: e.text, terms: e.terms };
  }
  write(file, slim);
  if (index.textDirty || !fs.existsSync(opts.textFile)) {
    fs.mkdirSync(path.dirname(opts.textFile), { recursive: true });
    write(opts.textFile, { version: 1, root: index.root, files: texts });
    index.textDirty = false;
  }
}

// 메모리에 있는 본문 (다른 PC가 고친 색인을 다시 읽을 때 캐시 파일 대신 쓴다)
function textSourceOf(index) {
  const out = {};
  for (const e of Object.values((index && index.files) || {})) if (e.text !== undefined && !e.needsText) out[e.rel] = { s: stampOf(e), text: e.text, terms: e.terms };
  return out;
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

const USER_FIELDS = ["userCategory", "userTags", "hiddenTags", "note", "starred", "issuedAt", "validUntil"]; // issuedAt·validUntil: 증빙 발급일·유효기간을 직접 적은 것

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
    protectedText: !!x.protected, // 암호·배포용 문서라 앞부분(미리보기)만 읽음
    extractVersion: EXTRACT_VERSION,
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
  index.textDirty = true;
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
    return !e || e.size !== f.size || e.mtimeMs !== f.mtimeMs || e.needsText;
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
    index.textDirty = true;
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

module.exports = { reclassify, textSourceOf, upgradeIfNeeded, loadIndex, saveIndex, emptyIndex, scan, reclassifyAll, effective, nameParts, buildEntry, addFile, walk, isTempName, USER_FIELDS };
