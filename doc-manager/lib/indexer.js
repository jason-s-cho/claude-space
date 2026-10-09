// 지정한 폴더를 훑어서 문서 목록(색인)을 만들고 JSON 파일에 저장한다.
// 크기·수정 시각이 그대로인 파일은 다시 읽지 않는다.
// 내가 직접 고친 분류·태그·메모는 자동 분류보다 우선하며, 파일 이름을 바꾸거나 옮겨도 따라간다.
const fs = require("fs");
const path = require("path");
const { extract, fileKind } = require("./extract");
const { classify } = require("./classify");

const INDEX_VERSION = 1;
const SKIP_DIRS = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", ".Trash"]);

function emptyIndex(root) {
  return { version: INDEX_VERSION, root, files: {} };
}

function loadIndex(file, root) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && data.version === INDEX_VERSION && data.root === root && data.files) return data;
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
    const x = await extract(f.full);
    const entry = {
      rel: f.rel,
      size: f.size,
      mtimeMs: f.mtimeMs,
      birthtimeMs: f.birthtimeMs,
      kind: x.kind,
      title: x.title || "",
      author: x.author || "",
      pages: x.pages || 0,
      text: x.text,
      error: x.error,
      indexedAt: Date.now(),
    };
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
    if (!seen.has(rel)) {
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
}

module.exports = { loadIndex, saveIndex, emptyIndex, scan, reclassifyAll, effective, nameParts, USER_FIELDS };
