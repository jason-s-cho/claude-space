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
const forms = require("./forms");
const convertLib = require("./convert");
const { compareTexts } = require("./diff");
const appsLib = require("./applications");
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
    const textFile = store.textCacheFile(this.userDataDir, s.root);
    try {
      mtime += fs.statSync(textFile).mtimeMs;
    } catch {}
    const key = file + "|" + JSON.stringify(s.aiExcludeCategories || []);
    if (this.cache.file === key && this.cache.mtime === mtime && this.cache.views) return this.cache;
    const index = indexer.loadIndex(file, s.root, { anyRoot, textFile });
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
          textNs: e.text ? e.text.toLowerCase().split(/\s+/).join("") : "", // replace 로 만든 문자열은 검색이 수십 배 느리다
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

  // ---- 양식 채우기 ----

  // 양식 파일: 색인에 있는 문서이거나, 방금 이 커넥터가 만든 파일(앱이 아직 색인하지 않았을 수 있다)
  formSource(rel) {
    rel = String(rel || "").replace(/\\/g, "/");
    let v;
    try {
      v = this.visible(rel);
    } catch (e) {
      if (/AI 제외/.test(e.message) || !this.createdByConnector(rel)) throw e;
      v = { rel, versions: null };
    }
    const full = path.join(this.root(), ...v.rel.split("/"));
    if (!fs.existsSync(full)) throw new Error("파일이 없습니다: " + v.rel);
    return { v, full, ext: path.extname(v.rel).toLowerCase() };
  }

  createdByConnector(rel) {
    try {
      const log = fs.readFileSync(path.join(store.paths(this.root()).dir, "ai-log.jsonl"), "utf8");
      return log.split("\n").some((l) => l.includes('"new_path"') && l.includes(JSON.stringify(rel)));
    } catch {
      return false;
    }
  }

  // .hwp / .doc 양식이면 convert_document 로 먼저 바꾸라고 알려 준다
  formOnly(ext) {
    if (ext === ".hwp" || ext === ".doc") {
      const to = ext === ".hwp" ? ".hwpx" : ".docx";
      throw new Error(
        `${ext} 양식은 바로 채울 수 없습니다. convert_document 로 ${to} 사본을 만든 뒤(이 PC의 ${ext === ".hwp" ? "한글" : "워드"}이 필요) 그 파일로 inspect_form 을 다시 부르세요. ` +
          `안 되면 사용자에게 ${ext === ".hwp" ? "한글" : "워드"}에서 '다른 이름으로 저장 → ${to}' 를 부탁하세요.`
      );
    }
  }

  async inspectForm(rel, { offset = 0 } = {}) {
    const { v, full, ext } = this.formSource(rel);
    this.formOnly(ext);
    const r = await forms.inspectForm(await fs.promises.readFile(full), ext, { offset });
    return { path: v.rel, ...r };
  }

  // 양식을 채워 새 파일로 저장한다. new_name 을 주면 그 이름으로 (같은 폴더, 같은 확장자), 아니면 다음 버전 이름으로.
  async fillForm(rel, fills, { newName, tableRows } = {}) {
    const { v, full, ext } = this.formSource(rel);
    this.formOnly(ext);
    const r = await forms.fillForm(await fs.promises.readFile(full), ext, fills, { tableRows });
    const root = this.root();
    let t;
    if (newName) {
      let name = path.basename(String(newName).trim()).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
      if (!name || name.startsWith(".")) throw new Error("새 파일 이름이 올바르지 않습니다");
      const e = path.extname(name).toLowerCase();
      if (!e) name += ext;
      else if (e !== ext) throw new Error(`새 파일도 원본과 같은 형식(${ext})이어야 합니다`);
      const dir = path.dirname(full);
      t = { full: path.join(dir, name), rel: path.relative(root, path.join(dir, name)).split(path.sep).join("/") };
      if (fs.existsSync(t.full)) throw new Error(`같은 이름의 파일이 이미 있습니다: ${t.rel} (다른 이름을 주거나 new_name 을 빼면 다음 버전 이름으로 저장합니다)`);
    } else t = this.newVersionTarget(v);
    await fs.promises.writeFile(t.full, r.buffer, { flag: "wx" }); // 덮어쓰기 없음
    return {
      source: v.rel,
      new_path: t.rel,
      filled: r.filled,
      rows_added: r.rows_added || undefined,
      restyled_from_guide_text: r.restyled.length ? r.restyled : undefined,
      note_for_ai: "원본은 그대로입니다. 새 파일을 다시 고치려면 inspect_form 을 새 파일 경로로 다시 불러 칸 번호를 확인하세요 (줄을 늘리면 뒤쪽 문단 번호가 바뀝니다).",
    };
  }

  // 이 PC의 한글·워드로 다른 형식 사본을 만든다 (.hwp→.hwpx, .doc→.docx, →.pdf)
  async convertDocument(rel, to, opts) {
    const { v, full } = this.formSource(rel);
    const r = await convertLib.convert(full, to, opts);
    const newRel = path.relative(this.root(), r.output).split(path.sep).join("/");
    return {
      source: v.rel,
      new_path: newRel,
      converted_with: r.app,
      note_for_ai: /\.(hwpx|docx)$/i.test(newRel) ? "이 새 파일로 inspect_form → fill_form 을 쓰면 됩니다. 원본은 그대로입니다." : "원본은 그대로입니다.",
    };
  }

  // 두 문서(보통 같은 문서의 두 버전)에서 바뀐 곳. 먼저 고친 쪽을 이전으로 놓는다.
  async compareVersions(relA, relB, { limit = 120 } = {}) {
    const a = this.formSource(relA), b = this.formSource(relB);
    const time = (x) => fs.statSync(x.full).mtimeMs;
    const [older, newer] = time(a) <= time(b) ? [a, b] : [b, a];
    const read = async (x) => {
      const t = await extract(x.full, { maxText: READ_MAX });
      if (t.protected) throw new Error(`${x.v.rel}: 암호·배포용 문서라 본문을 다 읽을 수 없습니다`);
      return t.text || "";
    };
    const r = compareTexts(await read(older), await read(newer));
    const cut = (s) => (s && s.length > 800 ? s.slice(0, 800) + "…" : s);
    const changes = r.blocks
      .filter((x) => x.t !== "eq")
      .map((x) =>
        x.t === "mod"
          ? { type: "고침", before: cut(x.a), after: cut(x.b) }
          : x.t === "ins"
            ? { type: "추가", after: cut(x.b) }
            : { type: "삭제", before: cut(x.a) }
      );
    return {
      older: older.v.rel,
      newer: newer.v.rel,
      stats: { 고친_문단: r.stats.changed, 추가: r.stats.added, 삭제: r.stats.removed, 같음: r.stats.same },
      changed_numbers: r.numbers.length ? r.numbers : undefined,
      changes: changes.slice(0, limit),
      more_changes: changes.length > limit ? changes.length - limit : undefined,
    };
  }

  // ---- 지원 건 ----

  // AI 에게 보여도 되는 문서만 남긴 연결 목록
  visibleDocs(docs) {
    return docs.filter((rel) => {
      try {
        this.formSource(rel); // 보관함에 있거나 방금 커넥터가 만든 문서 (AI 제외 문서는 빠진다)
        return true;
      } catch {
        return false;
      }
    });
  }

  // 지원 건 목록 (찾기: 과제명·주제·사업·기관·메모에 들어 있는 글자, 결과: 준비|진행 중|탈락|선정, 연도)
  listApplications({ query = "", state = "", year } = {}) {
    const data = appsLib.load(this.root());
    const q = String(query || "").toLowerCase().replace(/\s+/g, "");
    const items = data.items
      .map((a) => ({ a, p: appsLib.progress(a) }))
      .filter(({ a, p }) => (!q || [a.title, a.topic, a.program, a.agency, a.memo].join(" ").toLowerCase().replace(/\s+/g, "").includes(q)) && (!state || p.state === state) && (!year || a.year === year))
      .sort((x, y) => (y.a.year || 0) - (x.a.year || 0) || y.a.updatedAt.localeCompare(x.a.updatedAt));
    return {
      templates: data.templates,
      total: items.length,
      applications: items.map(({ a, p }) => ({
        id: a.id,
        title: a.title,
        topic: a.topic,
        program: a.program,
        agency: a.agency || undefined,
        year: a.year,
        progress: `${p.state}${p.stage ? " (" + p.stage + ")" : ""}`,
        stages: a.stages.map((st) => `${st.name}: ${st.status || "-"}${st.date ? " " + st.date : ""}${st.note ? " — " + st.note.slice(0, 80) : ""}`),
      })),
    };
  }

  getApplication(id) {
    const data = appsLib.load(this.root());
    const a = data.items.find((x) => x.id === id);
    if (!a) throw new Error("없는 지원 건입니다: " + id + " (list_applications 로 id 를 확인하세요)");
    return { ...a, progress: appsLib.progress(a), stages: a.stages.map((st) => ({ ...st, docs: this.visibleDocs(st.docs) })) };
  }

  saveApplication(op) {
    const r = appsLib.update(this.root(), op);
    return r.id ? this.getApplication(r.id) : { done: true, templates: appsLib.load(this.root()).templates };
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
