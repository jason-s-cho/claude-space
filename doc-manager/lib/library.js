// Claude 커넥터(MCP 서버)가 문서 보관함을 보는 창구.
// 앱이 만든 색인(.docmanager/index.json)과 설정을 읽기만 하고, 새 파일은 '새 버전'으로만 만든다.
// 기존 파일을 고치거나 지우는 기능은 일부러 두지 않는다.
//
// AI 제외: 'AI제외' 태그가 붙은 문서와, 설정에서 고른 분류(aiExcludeCategories)의 문서는
// 검색·읽기·관련 문서 어디에도 나오지 않는다.
// 기록: Claude 가 무엇을 찾고 읽고 만들었는지 .docmanager/ai-log.jsonl 에 한 줄씩 남긴다.
const fs = require("fs");
const path = require("path");
const indexer = require("./indexer");
const store = require("./store");
const searchLib = require("./search");
const { extract, SUPPORTED } = require("./extract");
const { CATEGORIES, migrateOverrides } = require("./classify");
const { docFrequency, topKeywords } = require("./keywords");
const knowledge = require("./knowledge");
const { groupVersions, nextVersionName, uniqueVersionName } = require("./versions");

const AI_EXCLUDE_TAG = "AI제외";
const READ_MAX = 400000; // 한 문서에서 읽을 수 있는 최대 글자 수
const PAGE = 20000; // 한 번에 돌려주는 글자 수
const SAVE_MAX_BYTES = 60 * 1024 * 1024;

const catOf = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES.find((c) => c.id === "other");
const catLabel = (id) => {
  const c = catOf(id);
  return c.group ? `${c.group} · ${c.label}` : c.label;
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

class Library {
  // userDataDir: 앱의 앱 데이터 폴더 (PC 설정: 마지막으로 연 문서 폴더 등)
  constructor({ userDataDir }) {
    this.userDataDir = userDataDir;
    this.cache = { file: "", mtime: 0, index: null, views: null };
  }

  // ---- 설정과 색인 ----

  settings() {
    const pc = readJson(path.join(this.userDataDir, "settings.json")) || {};
    if (!pc.root) throw new Error("문서 보관함에서 아직 문서 폴더를 고르지 않았습니다. 앱을 열어 폴더를 골라 주세요.");
    if (!fs.existsSync(pc.root)) throw new Error("문서 폴더를 찾을 수 없습니다: " + pc.root);
    const folder = readJson(store.paths(pc.root).settings) || {};
    const s = { ...pc, ...folder };
    s.keywordOverrides = migrateOverrides(s.keywordOverrides);
    return s;
  }

  root() {
    return this.settings().root;
  }

  indexFile(root) {
    const inFolder = store.paths(root).index;
    if (fs.existsSync(inFolder)) return { file: inFolder, anyRoot: true };
    return { file: path.join(this.userDataDir, "index.json"), anyRoot: false };
  }

  // 색인을 읽어 문서마다 검색·표시에 쓸 정보를 만든다. 색인 파일이 바뀔 때만 다시 만든다.
  load() {
    const s = this.settings();
    const { file, anyRoot } = this.indexFile(s.root);
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {}
    const key = file + "|" + JSON.stringify(s.aiExcludeCategories || []);
    if (this.cache.file === key && this.cache.mtime === mtime && this.cache.views) return this.cache;
    const index = indexer.loadIndex(file, s.root, { anyRoot });
    const entries = Object.values(index.files);
    const df = docFrequency(entries.map((e) => e.terms));
    const versions = groupVersions(entries.map((e) => ({ rel: e.rel, base: e.rel.split("/").pop(), mtimeMs: e.mtimeMs })));
    const excludedCats = new Set(s.aiExcludeCategories || []);
    const views = new Map();
    for (const e of entries) {
      const eff = indexer.effective(e);
      const p = indexer.nameParts(e.rel);
      const years = new Set(eff.tags.filter((t) => /^20\d{2}$/.test(t)));
      years.add(String(new Date(e.mtimeMs).getFullYear()));
      const excluded = eff.tags.includes(AI_EXCLUDE_TAG) || excludedCats.has(eff.category);
      views.set(e.rel, {
        rel: e.rel,
        entry: e,
        excluded,
        category: eff.category,
        tags: eff.tags,
        keywords: topKeywords(e.terms, df, entries.length),
        versions: versions.get(e.rel) || null,
        // search.js 가 쓰는 모양
        search: {
          name: p.base,
          dir: p.dir,
          title: e.title || "",
          note: e.note || "",
          tags: eff.tags,
          keywords: [],
          kind: e.kind,
          ext: p.ext,
          years: [...years],
          catText: catLabel(eff.category),
          textNs: (e.text || "").toLowerCase().replace(/\s+/g, ""),
        },
      });
    }
    for (const v of views.values()) v.search.keywords = v.keywords;
    this.cache = { file: key, mtime, index, views, root: s.root, settings: s };
    return this.cache;
  }

  // AI 에게 보여도 되는 문서 하나. 없거나 제외된 문서면 오류.
  visible(rel) {
    const { views } = this.load();
    const v = views.get(String(rel || "").replace(/\\/g, "/"));
    if (!v) throw new Error("문서를 찾을 수 없습니다: " + rel + " (search_documents 로 찾은 path 를 그대로 써 주세요)");
    if (v.excluded) throw new Error("이 문서는 AI 제외로 설정되어 있어 열 수 없습니다.");
    return v;
  }

  summary(v, extra = {}) {
    const e = v.entry;
    const ver = v.versions;
    return {
      path: v.rel,
      name: v.rel.split("/").pop(),
      folder: indexer.nameParts(v.rel).dir || "(최상위)",
      category: catLabel(v.category),
      tags: v.tags,
      modified: new Date(e.mtimeMs).toISOString().slice(0, 10),
      pages: e.pages || undefined,
      keywords: v.keywords.slice(0, 8),
      note: e.note || undefined,
      versions: ver ? { count: ver.size, is_latest: ver.latest === v.rel, latest: ver.latest } : undefined,
      partial_text: e.protectedText || undefined,
      ...extra,
    };
  }

  // ---- 도구 ----

  overview() {
    const { views, root, settings } = this.load();
    const allShown = [...views.values()].filter((v) => !v.excluded);
    // 문서 수는 search_documents 기본값처럼 문서마다 최신 버전 하나로 센다
    const shown = allShown.filter((v) => !v.versions || v.versions.latest === v.rel);
    const count = (fn) => shown.filter(fn).length;
    const tagCount = new Map();
    for (const v of shown) for (const t of v.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    return {
      folder: path.basename(root),
      documents: shown.length,
      files_including_old_versions: allShown.length,
      hidden_by_ai_exclusion: views.size - allShown.length,
      counting_note: "documents 와 분류별 수는 문서마다 최신 버전 하나로 센 수입니다. 이전 버전 파일까지 합친 수는 files_including_old_versions 입니다.",
      categories: CATEGORIES.map((c) => ({ category: catLabel(c.id), count: count((v) => v.category === c.id) })).filter((x) => x.count),
      projects: (settings.projects || []).map((p) => ({ name: p.name, count: count((v) => v.tags.includes(p.name)) })),
      partners: (settings.partners || []).map((p) => ({ name: p.name, count: count((v) => v.tags.includes(p.name)) })),
      top_tags: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([tag, n]) => ({ tag, count: n })),
      search_syntax: '단어 여러 개 = 모두 포함, "구절", A|B, -제외, #태그, 분류:보고서, 연도:2025, 형식:ppt(word/excel/pdf/hwp), 폴더:이름, 이름:최종, 키워드:그래핀',
    };
  }

  search(query, { limit = 15, latestOnly = false } = {}) {
    const { views } = this.load();
    const parsed = searchLib.parseQuery(query || "");
    let hits = [];
    for (const v of views.values()) {
      if (v.excluded) continue;
      const score = searchLib.isEmpty(parsed) ? 1 : searchLib.matchView(v.search, parsed);
      if (score > 0) hits.push({ v, score });
    }
    if (latestOnly) hits = hits.filter(({ v }) => !v.versions || v.versions.latest === v.rel);
    hits.sort((a, b) => b.score - a.score || b.v.entry.mtimeMs - a.v.entry.mtimeMs);
    const total = hits.length;
    return {
      total,
      results: hits.slice(0, limit).map(({ v }) =>
        this.summary(v, { snippet: searchLib.snippet(v.entry.text || "", parsed.highlight) || undefined })
      ),
    };
  }

  // 본문 전체를 파일에서 다시 읽는다 (색인에는 앞부분만 있으므로). offset 부터 PAGE 글자.
  async read(rel, { offset = 0 } = {}) {
    const v = this.visible(rel);
    const full = path.join(this.root(), ...v.rel.split("/"));
    const x = await extract(full, { maxText: READ_MAX });
    const text = x.text || "";
    const start = Math.max(0, Math.min(offset, text.length));
    const end = Math.min(text.length, start + PAGE);
    return {
      ...this.summary(v),
      text: text.slice(start, end),
      offset: start,
      next_offset: end < text.length ? end : null,
      total_chars: text.length,
      truncated_at_limit: text.length >= READ_MAX || undefined,
      note_for_ai: x.protected
        ? "암호·배포용 한글 문서라 앞부분(미리보기)만 읽을 수 있습니다."
        : !text
          ? "본문 글자를 읽을 수 없는 문서입니다(스캔 PDF, 옛 형식 .ppt/.xls 등)."
          : undefined,
    };
  }

  versions(rel) {
    const v = this.visible(rel);
    const { views } = this.load();
    if (!v.versions) return { path: v.rel, versions: [this.summary(v)] };
    return {
      path: v.rel,
      latest: v.versions.latest,
      versions: v.versions.order.map((r) => views.get(r)).filter((x) => x && !x.excluded).map((x) => this.summary(x)),
    };
  }

  // 같은 과제·고객사·기술 태그와 핵심 키워드가 많이 겹치는 문서 (같은 문서의 다른 버전은 뺀다)
  related(rel, { limit = 10 } = {}) {
    const v = this.visible(rel);
    const { views } = this.load();
    const kw = new Set(v.keywords);
    const tags = new Set(v.tags.filter((t) => !/^20\d{2}$/.test(t)));
    const family = new Set(v.versions ? v.versions.order : [v.rel]);
    const scored = [];
    for (const o of views.values()) {
      if (o.excluded || family.has(o.rel)) continue;
      const sharedKw = o.keywords.filter((k) => kw.has(k));
      const sharedTags = o.tags.filter((t) => tags.has(t));
      const score = sharedKw.length * 2 + sharedTags.length + (o.category === v.category ? 0.5 : 0);
      if (sharedKw.length || sharedTags.length) scored.push({ o, score, sharedKw, sharedTags });
    }
    scored.sort((a, b) => b.score - a.score || b.o.entry.mtimeMs - a.o.entry.mtimeMs);
    return {
      path: v.rel,
      related: scored.slice(0, limit).map(({ o, sharedKw, sharedTags }) => this.summary(o, { shared_keywords: sharedKw, shared_tags: sharedTags })),
    };
  }

  // 새 버전 파일 이름(같은 폴더). ext 를 주면 확장자를 바꾼다 (예: PDF 를 보고 Word 로 다시 쓴 경우).
  newVersionTarget(v, ext) {
    const root = this.root();
    const dir = path.join(root, ...indexer.nameParts(v.rel).dir.split("/").filter(Boolean));
    const siblings = v.versions ? v.versions.order.map((r) => r.split("/").pop()) : [];
    let base = v.rel.split("/").pop();
    if (ext) {
      const e = ext.startsWith(".") ? ext.toLowerCase() : "." + ext.toLowerCase();
      if (!SUPPORTED[e]) throw new Error("지원하지 않는 형식입니다: " + e + " (docx, pptx, xlsx, pdf, hwpx, hwp 등)");
      base = base.replace(/\.[^.]+$/, "") + e;
    }
    const name = uniqueVersionName(nextVersionName(base, siblings), (n) => fs.existsSync(path.join(dir, n)));
    return { dir, name, full: path.join(dir, name), rel: path.relative(root, path.join(dir, name)).split(path.sep).join("/") };
  }

  // 원본을 그대로 복사해 새 버전 파일을 만들고 전체 경로를 돌려준다 (파일을 직접 고칠 수 있는 Claude Code 용)
  async prepareNewVersion(rel) {
    const v = this.visible(rel);
    const t = this.newVersionTarget(v);
    await fs.promises.copyFile(path.join(this.root(), ...v.rel.split("/")), t.full, fs.constants.COPYFILE_EXCL);
    const now = new Date();
    await fs.promises.utimes(t.full, now, now);
    return { source: v.rel, new_path: t.rel, absolute_path: t.full };
  }

  // Claude 가 만든 파일 내용(base64)을 새 버전으로 저장한다. 기존 파일은 절대 덮어쓰지 않는다.
  async saveNewVersion(rel, contentBase64, { ext } = {}) {
    const v = this.visible(rel);
    const buf = Buffer.from(String(contentBase64 || ""), "base64");
    if (!buf.length) throw new Error("저장할 파일 내용이 비어 있습니다 (base64 로 보내 주세요).");
    if (buf.length > SAVE_MAX_BYTES) throw new Error("파일이 너무 큽니다 (60MB 이하).");
    const t = this.newVersionTarget(v, ext);
    await fs.promises.writeFile(t.full, buf, { flag: "wx" }); // 'wx': 이미 있으면 실패 → 덮어쓰기 없음
    return { source: v.rel, new_path: t.rel, bytes: buf.length };
  }

  // ---- 기록 ----

  // ---- 회사 지식 카드 ----

  getKnowledge() {
    const root = this.root();
    const k = knowledge.read(root);
    return {
      exists: k.exists,
      updated: k.updated,
      file: `${knowledge.DIR_NAME}/${knowledge.CARD_NAME}`,
      card: k.exists ? k.content : knowledge.TEMPLATE,
      note_for_ai: k.exists
        ? "문서를 쓰거나 고칠 때 이 카드의 사실·수치·표현을 우선 쓰세요. 카드와 문서가 다르면 사용자에게 알려 주세요."
        : "아직 지식 카드가 없습니다. 위 card 는 빈 양식입니다. 사용자가 원하면 아래 순서로 만들어 save_knowledge_card 로 저장하세요.\n" + knowledge.BUILD_STEPS,
    };
  }

  saveKnowledge(content) {
    const r = knowledge.save(this.root(), content, { protectUserSection: true });
    return {
      saved: `${knowledge.DIR_NAME}/${knowledge.CARD_NAME}`,
      previous_kept: !!r.backup,
      user_section_restored: r.keptUserSection || undefined,
    };
  }

  log(tool, detail) {
    try {
      const root = this.root();
      if (!store.ensureDir(root)) return;
      const line = JSON.stringify({ time: new Date().toISOString(), tool, ...detail }) + "\n";
      fs.appendFileSync(path.join(store.paths(root).dir, "ai-log.jsonl"), line);
    } catch {}
  }
}

// 최근 기록 (화면 표시용)
function readLog(root, limit = 50) {
  try {
    const lines = fs.readFileSync(path.join(store.paths(root).dir, "ai-log.jsonl"), "utf8").trim().split("\n");
    return lines.slice(-limit).reverse().map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { Library, readLog, AI_EXCLUDE_TAG, PAGE, READ_MAX };
