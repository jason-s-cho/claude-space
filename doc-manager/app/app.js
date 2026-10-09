"use strict";

const api = window.docs;
const $ = (id) => document.getElementById(id);

const KIND_LABEL = { word: "Word", ppt: "PowerPoint", excel: "Excel", pdf: "PDF", hwp: "한글" };
const KIND_SHORT = { word: "DOC", ppt: "PPT", excel: "XLS", pdf: "PDF", hwp: "HWP" };
const YEAR_RE = /^20\d{2}$/;
const DAY = 86400000;

let S = { root: "", categories: [], docs: [], scanning: false, progress: null, settings: {} };
let byRel = new Map();
let catById = {};
const filter = { view: "all", tags: new Set(), kind: "" };
let query = "";
let results = null; // 검색 중이면 Map(rel → { score, snippet })
let hlTerms = []; // 검색어 중 화면에 칠할 글자
let selected = "";
let visible = [];
let showAllTags = false;
let searchSeq = 0;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 검색어를 칠한다. 띄어쓰기는 있어도 없어도 맞춘다 ("전자파 차폐" = "전자파차폐").
function highlight(text) {
  let html = esc(text);
  const pats = hlTerms
    .map((t) => [...esc(t).replace(/\s+/g, "")].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"))
    .filter(Boolean);
  if (pats.length) html = html.replace(new RegExp(`(${pats.join("|")})`, "gi"), "<mark>$1</mark>");
  return html;
}

function catLabel(id, withGroup = true) {
  const c = catById[id] || catById.other;
  return withGroup && c.group ? `${c.group} · ${c.label}` : c.label;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

// ---------- 상태 받기 ----------

function applyState(next) {
  S = next;
  catById = Object.fromEntries(S.categories.map((c) => [c.id, c]));
  byRel = new Map(S.docs.map((d) => [d.rel, d]));
  if (selected && !byRel.has(selected)) selected = "";
  $("welcome").hidden = !!S.root;
  $("layout").hidden = !S.root;
  $("rootPath").textContent = S.root || "";
  $("rootPath").title = S.root ? S.root + " (클릭하면 폴더 열기)" : "";
  $("rescanBtn").disabled = !S.root;
  renderStatus();
  if (query) runSearch();
  else renderAll();
}

// 메모나 태그를 입력하는 중에는 오른쪽 칸을 다시 그리지 않는다. (입력하던 글자가 지워지지 않도록)
function editingDetail() {
  const a = document.activeElement;
  return !!(a && $("detail").contains(a) && (a.tagName === "TEXTAREA" || a.tagName === "INPUT"));
}

function renderStatus() {
  const st = $("status");
  if (S.scanning) {
    const p = S.progress;
    st.textContent = p && p.total ? `읽는 중 ${p.done}/${p.total} · ${p.current.split("/").pop()}` : "폴더 확인 중…";
  } else {
    st.textContent = S.root ? `문서 ${S.docs.length}개` : "";
  }
}

// ---------- 걸러내기 ----------

function matchesView(d, view) {
  if (view === "all") return true;
  if (view === "starred") return d.starred;
  if (view === "recent") return Date.now() - d.mtimeMs < 30 * DAY;
  if (view.startsWith("group:")) return (catById[d.category] || {}).group === view.slice(6);
  if (view.startsWith("cat:")) return d.category === view.slice(4);
  return true;
}

function filtered() {
  let list = S.docs.filter((d) => matchesView(d, filter.view));
  if (filter.kind) list = list.filter((d) => d.kind === filter.kind);
  for (const t of filter.tags) list = list.filter((d) => d.tags.includes(t));
  if (results) list = list.filter((d) => results.has(d.rel));
  const sort = $("sort").value;
  const order = S.categories.map((c) => c.id);
  const cmp = {
    mtime: (a, b) => b.mtimeMs - a.mtimeMs,
    name: (a, b) => a.base.localeCompare(b.base, "ko"),
    category: (a, b) => order.indexOf(a.category) - order.indexOf(b.category) || b.mtimeMs - a.mtimeMs,
    relevance: (a, b) => (results ? results.get(b.rel).score - results.get(a.rel).score : 0) || b.mtimeMs - a.mtimeMs,
  }[sort];
  return list.sort(cmp);
}

// ---------- 그리기 ----------

function renderAll(force = false) {
  renderSide();
  renderList();
  if (force || !editingDetail()) renderDetail();
}

function navItem(view, label, n, opts = {}) {
  const on = filter.view === view ? " on" : "";
  const dot = opts.color ? `<span class="dot" style="background:${opts.color}"></span>` : "";
  return `<button class="nav-item${on}${opts.sub ? " sub" : ""}${n ? "" : " zero"}" data-view="${esc(view)}" type="button">${dot}<span>${esc(label)}</span><span class="n">${n}</span></button>`;
}

function renderSide() {
  const docs = S.docs;
  const count = (fn) => docs.filter(fn).length;
  let h = "";
  const saved = S.settings.savedSearches || [];
  if (saved.length) {
    h += "<h3>저장한 검색</h3>";
    saved.forEach((sv, i) => {
      h += `<div class="saved-row"><button class="nav-item" data-saved="${i}" type="button" title="${esc(savedTitle(sv))}"><span>🔎</span><span class="ell">${esc(sv.name)}</span></button><button class="x" data-unsave="${i}" type="button" aria-label="삭제" title="삭제">×</button></div>`;
    });
  }
  h += "<h3>보기</h3>";
  h += navItem("all", "전체 문서", docs.length);
  h += navItem("starred", "★ 즐겨찾기", count((d) => d.starred));
  h += navItem("recent", "최근 30일", count((d) => Date.now() - d.mtimeMs < 30 * DAY));

  h += "<h3>분류</h3>";
  const groups = [];
  for (const c of S.categories) {
    if (!c.group) continue;
    let g = groups.find((x) => x.name === c.group);
    if (!g) groups.push((g = { name: c.group, cats: [] }));
    g.cats.push(c);
  }
  for (const g of groups) {
    if (g.cats.length > 1) {
      h += navItem("group:" + g.name, g.name, count((d) => (catById[d.category] || {}).group === g.name));
      for (const c of g.cats) h += navItem("cat:" + c.id, c.label, count((d) => d.category === c.id), { sub: true, color: c.color });
    } else {
      const c = g.cats[0];
      h += navItem("cat:" + c.id, c.label, count((d) => d.category === c.id), { color: c.color });
    }
  }
  h += navItem("cat:other", "미분류", count((d) => d.category === "other"), { color: catById.other.color });

  const tagCount = new Map();
  for (const d of docs) for (const t of d.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const years = [...tagCount.keys()].filter((t) => YEAR_RE.test(t)).sort().reverse();
  if (years.length) {
    h += '<h3>연도</h3><div class="tag-cloud">';
    for (const y of years) h += tagBtn(y, tagCount.get(y));
    h += "</div>";
  }

  h += '<h3>파일 형식</h3>';
  for (const k of Object.keys(KIND_LABEL)) {
    const n = count((d) => d.kind === k);
    if (!n) continue;
    h += `<button class="nav-item${filter.kind === k ? " on" : ""}" data-kind="${k}" type="button"><span class="dot" style="background:var(--k-${k})"></span><span>${KIND_LABEL[k]}</span><span class="n">${n}</span></button>`;
  }

  const tags = [...tagCount.entries()].filter(([t]) => !YEAR_RE.test(t)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
  if (tags.length) {
    h += '<h3>태그</h3><div class="tag-cloud">';
    const limit = showAllTags ? tags.length : 30;
    // 선택한 태그는 항상 보이게 한다.
    for (const [t, n] of tags.filter(([t], i) => i < limit || filter.tags.has(t))) h += tagBtn(t, n);
    h += "</div>";
    if (tags.length > 30) h += `<button class="more" id="moreTags" type="button">${showAllTags ? "접기" : `태그 ${tags.length - 30}개 더 보기`}</button>`;
  }
  // 여러 문서에서 핵심 키워드로 뽑힌 단어
  const kwCount = new Map();
  for (const d of docs) for (const k of d.keywords || []) kwCount.set(k, (kwCount.get(k) || 0) + 1);
  const kws = [...kwCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko")).slice(0, 25);
  if (kws.length) {
    h += '<h3 title="여러 문서에서 핵심 키워드로 뽑힌 단어. 누르면 본문 검색">자주 나오는 키워드</h3><div class="tag-cloud">';
    for (const [k, n] of kws) h += `<button class="tag-btn kw" data-kw="${esc(k)}" type="button">${esc(k)}<small>${n}</small></button>`;
    h += "</div>";
  }
  $("side").innerHTML = h;
}

function tagBtn(t, n) {
  return `<button class="tag-btn${filter.tags.has(t) ? " on" : ""}" data-tag="${esc(t)}" type="button">${esc(t)}<small>${n}</small></button>`;
}

function viewLabel(view) {
  if (view === "starred") return "★ 즐겨찾기";
  if (view === "recent") return "최근 30일";
  if (view.startsWith("group:")) return view.slice(6);
  if (view.startsWith("cat:")) return catLabel(view.slice(4));
  return "";
}

function renderList() {
  visible = filtered();
  let f = "";
  if (filter.view !== "all") f += `<span class="filter-chip">${esc(viewLabel(filter.view))}<button data-clear="view" type="button" aria-label="해제">×</button></span>`;
  if (filter.kind) f += `<span class="filter-chip">${KIND_LABEL[filter.kind]}<button data-clear="kind" type="button" aria-label="해제">×</button></span>`;
  for (const t of filter.tags) f += `<span class="filter-chip">#${esc(t)}<button data-clear-tag="${esc(t)}" type="button" aria-label="해제">×</button></span>`;
  if (query) f += `<span class="filter-chip">“${esc(query)}”<button data-clear="query" type="button" aria-label="해제">×</button></span>`;
  if (f) f += `<button class="btn small" data-act="save-search" type="button" title="지금 조건(검색어·분류·태그·형식)을 왼쪽 '저장한 검색'에 넣습니다">☆ 이 조건 저장</button>`;
  $("activeFilters").innerHTML = f || '<span class="count">전체 문서</span>';
  $("count").textContent = `${visible.length}개`;

  const rows = visible.map((d) => {
    const c = catById[d.category] || catById.other;
    const r = results && results.get(d.rel);
    const tags = d.tags.slice(0, 6).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    return `<li class="row${d.rel === selected ? " sel" : ""}" data-rel="${esc(d.rel)}" role="option" aria-selected="${d.rel === selected}">
      <span class="kind ${d.kind}">${KIND_SHORT[d.kind] || esc(d.ext.toUpperCase())}</span>
      <div class="row-main">
        <div class="row-title">${d.starred ? '<span class="star">★</span>' : ""}${highlight(d.name)}<span class="muted">.${esc(d.ext)}</span></div>
        <div class="row-sub">${esc(d.dir || "(최상위 폴더)")}</div>
        ${r && r.snippet ? `<div class="snippet">${highlight(r.snippet)}</div>` : ""}
        ${tags ? `<div class="row-tags">${tags}</div>` : ""}
      </div>
      <div class="row-side">
        <span class="badge${d.userCategory ? " manual" : ""}"><span class="dot" style="background:${c.color}"></span>${esc(c.label)}</span>
        <span class="date">${fmtDate(d.mtimeMs)}</span>
      </div>
    </li>`;
  });
  $("list").innerHTML = rows.join("");
  const empty = $("empty");
  empty.hidden = visible.length > 0;
  if (!visible.length) {
    empty.textContent = S.scanning && !S.docs.length ? "문서를 읽는 중입니다…" : S.docs.length ? "조건에 맞는 문서가 없습니다." : "이 폴더에 워드·파워포인트·엑셀·PDF·한글 파일이 없습니다.";
  }
}

async function renderDetail() {
  const box = $("detail");
  const d = byRel.get(selected);
  if (!d) {
    box.innerHTML = '<p class="detail-empty">문서를 고르면 여기에 정보가 나옵니다.<br><small>두 번 누르면 파일이 열립니다.</small></p>';
    return;
  }
  const opts = [`<option value="">자동 분류: ${esc(catLabel(d.autoCategory))}</option>`]
    .concat(S.categories.map((c) => `<option value="${c.id}"${d.userCategory === c.id ? " selected" : ""}>${esc(catLabel(c.id))}</option>`))
    .join("");
  const reason = d.userCategory
    ? `직접 고른 분류입니다. <button data-act="reset-cat" type="button">자동 분류로 되돌리기</button>`
    : (d.reasons.length ? `근거: ${esc(d.reasons.join(", "))}` : "분류할 단서를 찾지 못했습니다. 직접 골라 주세요.") +
      ` <button data-act="edit-keywords" type="button">분류 키워드 고치기</button>`;
  const userSet = new Set(d.userTags);
  const tagChips = d.tags.map((t) => `<span class="tag${userSet.has(t) ? " user" : ""}">${esc(t)}<button data-untag="${esc(t)}" type="button" aria-label="${esc(t)} 태그 빼기">×</button></span>`).join("");
  const hidden = d.hiddenTags.length
    ? `<div class="hidden-tags">뺀 자동 태그: ${d.hiddenTags.map((t) => `<button data-retag="${esc(t)}" type="button" title="다시 붙이기">${esc(t)} ↺</button>`).join("")}</div>`
    : "";
  const info = [
    ["형식", KIND_LABEL[d.kind] + (d.pages ? ` · ${d.pages}${d.kind === "ppt" ? "장" : "쪽"}` : "")],
    ["크기", fmtSize(d.size)],
    ["수정일", fmtDate(d.mtimeMs)],
    ["만든 날", fmtDate(d.birthtimeMs)],
    d.title ? ["문서 제목", d.title] : null,
    d.author ? ["작성자", d.author] : null,
  ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

  box.innerHTML = `
    <h2>${d.starred ? "★ " : ""}${esc(d.base)}</h2>
    <div class="path">${esc(d.dir ? d.dir + "/" : "")}</div>
    <div class="actions">
      <button class="btn primary" data-act="open" type="button">열기</button>
      <button class="btn" data-act="reveal" type="button">폴더에서 보기</button>
      <button class="btn" data-act="star" type="button">${d.starred ? "★ 즐겨찾기 해제" : "☆ 즐겨찾기"}</button>
    </div>
    <section>
      <h4>분류</h4>
      <select class="select" id="catSelect">${opts}</select>
      <div class="reason">${reason}</div>
    </section>
    <section>
      <h4>태그</h4>
      <div class="tag-edit">${tagChips}<input class="tag-input" id="tagInput" placeholder="+ 태그 추가" list="allTags"></div>
      <datalist id="allTags">${allTags().map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
      ${hidden}
    </section>
    <section>
      <h4>핵심 키워드 <small class="muted">누르면 같은 단어가 나오는 문서 검색 · ＋는 태그로</small></h4>
      ${d.keywords && d.keywords.length
        ? `<div class="kw-list">${d.keywords.map((k) => `<span class="kw-chip"><button data-kwsearch="${esc(k)}" type="button">${esc(k)}</button><button class="plus" data-kwtag="${esc(k)}" type="button" title="태그로 붙이기" aria-label="${esc(k)} 태그로 붙이기">＋</button></span>`).join("")}</div>`
        : '<p class="muted small">뽑을 만한 단어가 없습니다.</p>'}
    </section>
    <section>
      <h4>메모</h4>
      <textarea class="note" id="noteInput" placeholder="예: 2025.3 KEIT 제출본, 김부장님 검토 완료">${esc(d.note)}</textarea>
    </section>
    <section>
      <h4>정보</h4>
      <dl class="info">${info}</dl>
    </section>
    <section>
      <h4>본문 미리보기</h4>
      ${d.error ? `<p class="warn">본문을 읽지 못했습니다 (암호가 걸렸거나 손상된 파일일 수 있습니다). 파일 이름으로만 분류했습니다.</p>` : ""}
      ${d.hasText ? '<pre class="preview" id="preview">불러오는 중…</pre>' : !d.error ? `<p class="muted">${["ppt", "xls", "hwp"].includes(d.ext) ? "옛 형식 파일(." + esc(d.ext) + ")은 본문을 읽지 않고 파일 이름으로만 분류합니다. 새 형식(." + esc(d.ext) + "x)으로 저장하면 본문까지 읽습니다." : "본문 글자가 없습니다. (스캔한 PDF 등)"}</p>` : ""}
    </section>`;

  if (d.hasText) {
    const rel = d.rel;
    const text = await api.getText(rel);
    const pre = $("preview");
    if (!pre || selected !== rel) return;
    let shown = text.slice(0, 3000);
    const t = hlTerms[0];
    if (t) {
      const at = text.toLowerCase().indexOf(t.toLowerCase());
      if (at > 2500) shown = "…" + text.slice(at - 300, at + 2700);
    }
    pre.innerHTML = highlight(shown) + (text.length > shown.length ? "\n…" : "");
  }
}

function allTags() {
  const set = new Set();
  for (const d of S.docs) for (const t of d.tags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b, "ko"));
}

// ---------- 문서 고치기 ----------

async function patchDoc(rel, patch) {
  const updated = await api.updateDoc(rel, patch);
  if (!updated) return;
  const i = S.docs.findIndex((d) => d.rel === rel);
  if (i >= 0) S.docs[i] = updated;
  byRel.set(rel, updated);
}

async function addTag(d, tag) {
  tag = tag.trim().replace(/^#/, "");
  if (!tag) return;
  if (d.hiddenTags.includes(tag)) await patchDoc(d.rel, { hiddenTags: d.hiddenTags.filter((t) => t !== tag) });
  else if (!d.tags.includes(tag)) await patchDoc(d.rel, { userTags: [...d.userTags, tag] });
  renderAll(true);
  const input = $("tagInput");
  if (input) input.focus();
}

async function removeTag(d, tag) {
  if (d.userTags.includes(tag)) await patchDoc(d.rel, { userTags: d.userTags.filter((t) => t !== tag) });
  if (d.autoTags.includes(tag)) await patchDoc(d.rel, { hiddenTags: [...new Set([...d.hiddenTags, tag])] });
  renderAll(true);
}

function select(rel, scroll) {
  selected = rel;
  for (const li of $("list").querySelectorAll(".row")) {
    const on = li.dataset.rel === rel;
    li.classList.toggle("sel", on);
    li.setAttribute("aria-selected", on);
    if (on && scroll) li.scrollIntoView({ block: "nearest" });
  }
  renderDetail();
}

async function openDoc(rel) {
  const err = await api.openFile(rel);
  if (err) toast("파일을 열 수 없습니다: " + err);
}

// ---------- 검색 ----------

let searchTimer = null;
function onQuery() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const prev = query;
    query = $("q").value.trim();
    if (query && !prev) $("sort").value = "relevance";
    if (!query && $("sort").value === "relevance") $("sort").value = "mtime";
    runSearch();
  }, 200);
}

async function runSearch() {
  const seq = ++searchSeq;
  if (!query) {
    results = null;
    hlTerms = [];
    renderAll();
    return;
  }
  const r = await api.search(query);
  if (seq !== searchSeq) return;
  results = new Map(r.results.map((x) => [x.rel, x]));
  hlTerms = r.highlight;
  renderAll();
  // 잠시 그대로 두면 '최근 검색'에 넣는다.
  clearTimeout(rememberTimer);
  const q = query;
  rememberTimer = setTimeout(() => {
    if (query === q && results && results.size) rememberSearch(q);
  }, 2500);
}
let rememberTimer = null;

// 검색창에 글자를 넣고 바로 검색한다. (키워드·최근 검색·저장한 검색을 눌렀을 때)
function setQuery(q) {
  $("q").value = q;
  query = q.trim();
  $("sort").value = query ? "relevance" : "mtime";
  hideSuggest();
  runSearch();
  if (query) rememberSearch(query);
}

// 키워드로 찾기: 띄어쓰기가 있으면 구절로
function kwQuery(k) {
  return /\s/.test(k) ? `"${k}"` : k;
}

// ----- 최근 검색 · 저장한 검색 -----

function rememberSearch(q) {
  q = q.trim();
  if (!q) return;
  const recent = (S.settings.recentSearches || []).filter((x) => x !== q);
  recent.unshift(q);
  S.settings.recentSearches = recent.slice(0, 15);
  api.saveSearches({ recentSearches: S.settings.recentSearches });
}

function currentConditions() {
  return { q: query, view: filter.view, tags: [...filter.tags], kind: filter.kind };
}

function savedTitle(sv) {
  const parts = [];
  if (sv.view && sv.view !== "all") parts.push(viewLabel(sv.view));
  if (sv.kind) parts.push(KIND_LABEL[sv.kind]);
  for (const t of sv.tags || []) parts.push("#" + t);
  if (sv.q) parts.push(`“${sv.q}”`);
  return parts.join(" · ") || "전체 문서";
}

function saveCurrentSearch() {
  const sv = currentConditions();
  sv.name = savedTitle(sv);
  const saved = (S.settings.savedSearches || []).filter((x) => x.name !== sv.name);
  saved.unshift(sv);
  S.settings.savedSearches = saved;
  api.saveSearches({ savedSearches: saved });
  renderSide();
  toast("왼쪽 '저장한 검색'에 넣었습니다.");
}

function applySaved(sv) {
  filter.view = sv.view || "all";
  filter.tags = new Set(sv.tags || []);
  filter.kind = sv.kind || "";
  setQuery(sv.q || "");
}

function removeSaved(i) {
  const saved = [...(S.settings.savedSearches || [])];
  saved.splice(i, 1);
  S.settings.savedSearches = saved;
  api.saveSearches({ savedSearches: saved });
  renderSide();
}

// ----- 검색창 아래 펼침 목록 (최근 검색 · 검색 도움말) -----

function showSuggest() {
  const box = $("suggest");
  const recent = S.settings.recentSearches || [];
  let h = "";
  if (recent.length) {
    h += '<div class="sg-head">최근 검색<button class="link" data-clear-recent type="button">모두 지우기</button></div>';
    h += recent.map((q) => `<button class="sg-item" data-recent="${esc(q)}" type="button">${esc(q)}</button>`).join("");
  }
  h += `<div class="sg-head">검색하는 법</div>
    <dl class="sg-help">
      <dt>그래핀 센서</dt><dd>두 단어가 모두 있는 문서</dd>
      <dt>"전자파 차폐"</dt><dd>구절 그대로 (띄어쓰기 무시)</dd>
      <dt>그래핀|graphene</dt><dd>둘 중 하나라도</dd>
      <dt>-초안</dt><dd>이 단어가 있는 문서는 빼기</dd>
      <dt>#KEIT</dt><dd>태그</dd>
      <dt>분류:보고서</dt><dd>분류 이름에 '보고서'</dd>
      <dt>연도:2025</dt><dd>연도 태그나 수정한 해</dd>
      <dt>형식:ppt</dt><dd>word · ppt · excel · pdf · hwp</dd>
      <dt>폴더:고객사</dt><dd>폴더 이름 (이름: 메모: 키워드: 도 됨)</dd>
    </dl>`;
  box.innerHTML = h;
  box.hidden = false;
}

function hideSuggest() {
  $("suggest").hidden = true;
}

// ---------- 설정 ----------

function partnersToText(list) {
  return (list || []).map((p) => (p.aliases && p.aliases.length ? `${p.name} = ${p.aliases.join(", ")}` : p.name)).join("\n");
}

function rulesToText(list) {
  return (list || []).map((r) => (r.keywords && r.keywords.length ? `${r.tag}: ${r.keywords.join(", ")}` : r.tag)).join("\n");
}

function splitList(s) {
  return s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
}

function textToPartners(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, rest = ""] = l.split("=");
    return { name: name.trim(), aliases: splitList(rest) };
  }).filter((p) => p.name);
}

function textToRules(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.search(/[:：]/);
    return i < 0 ? { tag: l, keywords: [] } : { tag: l.slice(0, i).trim(), keywords: splitList(l.slice(i + 1)) };
  }).filter((r) => r.tag);
}

// ----- 분류 키워드 편집 -----
// 편집하는 동안은 kwDraft 에 담아 두고, 저장을 누르면 settings.keywordOverrides 로 보낸다.
let kwDraft = {};
let kwGroup = "gov_plan";

const WEIGHTS = [[2, "약함"], [4, "보통"], [6, "강함"]];
const weightLabel = (w) => (w >= 6 ? "강함" : w >= 4 ? "보통" : "약함");
const normKw = (k) => k.replace(/\s+/g, "").toLowerCase();

function renderKwEditor() {
  const g = kwGroup;
  const o = kwDraft[g] || { add: [], remove: [] };
  const removed = new Set((o.remove || []).map(normKw));
  const added = new Map((o.add || []).map(([k, w]) => [normKw(k), [k, w]]));
  const base = (S.defaultKeywords[g] || []).filter(([k]) => !added.has(normKw(k)));
  const chips = [];
  for (const [k, w] of [...added.values()]) {
    chips.push(`<span class="kwe user" title="내가 넣은 키워드 · ${weightLabel(w)}">${esc(k)}<i>${weightLabel(w)}</i><button data-kwdel="${esc(k)}" type="button" aria-label="빼기">×</button></span>`);
  }
  for (const [k, w] of base) {
    if (removed.has(normKw(k))) continue;
    chips.push(`<span class="kwe" title="기본 키워드 · ${weightLabel(w)}">${esc(k)}<i>${weightLabel(w)}</i><button data-kwdel="${esc(k)}" type="button" aria-label="빼기">×</button></span>`);
  }
  const off = base.filter(([k]) => removed.has(normKw(k)));
  $("kwChips").innerHTML = chips.join("") || '<span class="muted">키워드가 없습니다.</span>';
  $("kwRemoved").innerHTML = off.length
    ? "뺀 기본 키워드: " + off.map(([k]) => `<button data-kwrestore="${esc(k)}" type="button" title="되살리기">${esc(k)} ↺</button>`).join("")
    : "";
  for (const b of $("kwGroups").querySelectorAll("button")) b.classList.toggle("on", b.dataset.group === g);
}

function kwAdd(k, w) {
  k = k.trim();
  if (!k) return;
  const o = (kwDraft[kwGroup] = kwDraft[kwGroup] || { add: [], remove: [] });
  o.remove = (o.remove || []).filter((x) => normKw(x) !== normKw(k));
  const isBase = (S.defaultKeywords[kwGroup] || []).some(([b, bw]) => normKw(b) === normKw(k) && bw === w);
  o.add = (o.add || []).filter(([x]) => normKw(x) !== normKw(k));
  if (!isBase) o.add.push([k, w]);
  renderKwEditor();
}

function kwRemove(k) {
  const o = (kwDraft[kwGroup] = kwDraft[kwGroup] || { add: [], remove: [] });
  const wasAdded = (o.add || []).some(([x]) => normKw(x) === normKw(k));
  o.add = (o.add || []).filter(([x]) => normKw(x) !== normKw(k));
  const isBase = (S.defaultKeywords[kwGroup] || []).some(([b]) => normKw(b) === normKw(k));
  // 내가 넣은 키워드가 기본 키워드의 가중치만 바꾼 것이었다면 기본값으로 돌아가고, 아니면 뺀다.
  if (isBase && !wasAdded) o.remove = [...new Set([...(o.remove || []), k])];
  renderKwEditor();
}

function kwRestore(k) {
  const o = kwDraft[kwGroup];
  if (o) o.remove = (o.remove || []).filter((x) => normKw(x) !== normKw(k));
  renderKwEditor();
}

function setSettingsTab(tab) {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === tab);
  for (const p of document.querySelectorAll(".tab-panel")) p.hidden = p.dataset.panel !== tab;
}

function openSettings(tab = "rules", group) {
  $("partnersInput").value = partnersToText(S.settings.partners);
  $("rulesInput").value = rulesToText(S.settings.tagRules);
  kwDraft = JSON.parse(JSON.stringify(S.settings.keywordOverrides || {}));
  if (group) kwGroup = group;
  $("kwGroups").innerHTML = S.keywordGroups.map((g) => `<button type="button" data-group="${g.key}">${esc(g.label)}</button>`).join("");
  renderKwEditor();
  setSettingsTab(tab);
  $("settingsDlg").showModal();
}

// ---------- 이벤트 ----------

$("welcomeBtn").onclick = () => api.chooseFolder();
$("folderBtn").onclick = () => api.chooseFolder();
$("rescanBtn").onclick = () => api.rescan();
$("rootPath").onclick = () => api.openRoot();
$("settingsBtn").onclick = () => openSettings();
$("q").addEventListener("input", () => {
  onQuery();
  if ($("q").value) hideSuggest();
  else showSuggest();
});
$("q").addEventListener("focus", () => {
  if (!$("q").value) showSuggest();
});
$("q").addEventListener("blur", () => setTimeout(hideSuggest, 150));
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchTimer);
    setQuery($("q").value);
  }
});
$("suggest").addEventListener("mousedown", (e) => e.preventDefault()); // 누르는 동안 검색창 포커스 유지
$("suggest").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.recent !== undefined) setQuery(b.dataset.recent);
  if (b.hasAttribute("data-clear-recent")) {
    S.settings.recentSearches = [];
    api.saveSearches({ recentSearches: [] });
    showSuggest();
  }
});
$("sort").onchange = renderList;
$("exportBtn").onclick = async () => {
  if (!visible.length) return toast("내보낼 문서가 없습니다.");
  if (await api.exportCsv(visible.map((d) => d.rel))) toast(`${visible.length}개 문서 목록을 저장했습니다.`);
};

$("settingsDlg").addEventListener("close", async () => {
  if ($("settingsDlg").returnValue !== "save") return;
  await api.saveSettings({
    partners: textToPartners($("partnersInput").value),
    tagRules: textToRules($("rulesInput").value),
    keywordOverrides: kwDraft,
  });
  toast("설정을 저장하고 모든 문서를 다시 분류했습니다.");
});

$("side").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.saved !== undefined) return applySaved(S.settings.savedSearches[+b.dataset.saved]);
  if (b.dataset.unsave !== undefined) return removeSaved(+b.dataset.unsave);
  if (b.dataset.kw) return setQuery(kwQuery(b.dataset.kw));
  if (b.id === "moreTags") showAllTags = !showAllTags;
  else if (b.dataset.view) filter.view = filter.view === b.dataset.view && b.dataset.view !== "all" ? "all" : b.dataset.view;
  else if (b.dataset.kind) filter.kind = filter.kind === b.dataset.kind ? "" : b.dataset.kind;
  else if (b.dataset.tag) {
    const t = b.dataset.tag;
    filter.tags.has(t) ? filter.tags.delete(t) : filter.tags.add(t);
  }
  renderSide();
  renderList();
});

$("activeFilters").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.act === "save-search") return saveCurrentSearch();
  if (b.dataset.clear === "view") filter.view = "all";
  if (b.dataset.clear === "kind") filter.kind = "";
  if (b.dataset.clear === "query") {
    $("q").value = "";
    query = "";
    if ($("sort").value === "relevance") $("sort").value = "mtime";
    runSearch();
    return;
  }
  if (b.dataset.clearTag) filter.tags.delete(b.dataset.clearTag);
  renderSide();
  renderList();
});

$("list").addEventListener("click", (e) => {
  const li = e.target.closest(".row");
  if (li) select(li.dataset.rel);
});
$("list").addEventListener("dblclick", (e) => {
  const li = e.target.closest(".row");
  if (li) openDoc(li.dataset.rel);
});

$("detail").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  const d = byRel.get(selected);
  if (!b || !d) return;
  const act = b.dataset.act;
  if (act === "open") return openDoc(d.rel);
  if (act === "reveal") return api.showInFolder(d.rel);
  if (act === "star") await patchDoc(d.rel, { starred: !d.starred });
  if (act === "reset-cat") await patchDoc(d.rel, { userCategory: "" });
  if (b.dataset.untag) return removeTag(d, b.dataset.untag);
  if (b.dataset.retag) return addTag(d, b.dataset.retag);
  if (b.dataset.kwsearch) return setQuery(kwQuery(b.dataset.kwsearch));
  if (b.dataset.kwtag) return addTag(d, b.dataset.kwtag);
  if (act === "edit-keywords") {
    const cat = d.category === "gov_etc" ? "gov" : d.category;
    return openSettings("keywords", S.keywordGroups.some((g) => g.key === cat) ? cat : undefined);
  }
  renderAll(true);
});

$("detail").addEventListener("change", async (e) => {
  const d = byRel.get(selected);
  if (!d) return;
  if (e.target.id === "catSelect") {
    await patchDoc(d.rel, { userCategory: e.target.value });
    renderAll(true);
  }
  if (e.target.id === "tagInput" && e.target.value && allTags().includes(e.target.value)) {
    // 자동완성 목록에서 고른 경우
    const v = e.target.value;
    e.target.value = "";
    addTag(d, v);
  }
});

$("detail").addEventListener("keydown", (e) => {
  const d = byRel.get(selected);
  if (!d || e.target.id !== "tagInput") return;
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    const v = e.target.value;
    e.target.value = "";
    addTag(d, v);
  }
});

let noteTimer = null;
$("detail").addEventListener("input", (e) => {
  if (e.target.id !== "noteInput") return;
  const rel = selected;
  const value = e.target.value;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => patchDoc(rel, { note: value.trim() }), 500);
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    $("q").focus();
    $("q").select();
    return;
  }
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || $("settingsDlg").open) {
    if (e.key === "Escape" && e.target.id === "q" && $("q").value) {
      $("q").value = "";
      onQuery();
    }
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!visible.length) return;
    e.preventDefault();
    let i = visible.findIndex((d) => d.rel === selected);
    i = e.key === "ArrowDown" ? Math.min(visible.length - 1, i + 1) : Math.max(0, i - 1);
    select(visible[i].rel, true);
  } else if (e.key === "Enter" && selected) {
    openDoc(selected);
  }
});

api.onState(applyState);
api.onProgress((p) => {
  S.progress = p;
  S.scanning = true;
  renderStatus();
});
api.onScanDone((r) => {
  const parts = [];
  if (r.added) parts.push(`새 문서 ${r.added}개`);
  if (r.updated) parts.push(`바뀐 문서 ${r.updated}개`);
  if (r.removed) parts.push(`없어진 문서 ${r.removed}개`);
  if (parts.length) toast(parts.join(" · ") + " 반영했습니다.");
});
api.onScanError((msg) => toast(msg));

api.getState().then(applyState);

// 설정 창: 탭 · 분류 키워드 편집
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) setSettingsTab(b.dataset.tab);
});
$("kwGroups").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-group]");
  if (!b) return;
  kwGroup = b.dataset.group;
  renderKwEditor();
});
$("kwChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kwdel]");
  if (b) kwRemove(b.dataset.kwdel);
});
$("kwRemoved").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kwrestore]");
  if (b) kwRestore(b.dataset.kwrestore);
});
function kwAddFromInput() {
  const input = $("kwInput");
  for (const k of input.value.split(/[,，]/)) kwAdd(k, Number($("kwWeight").value));
  input.value = "";
  input.focus();
}
$("kwAddBtn").onclick = kwAddFromInput;
$("kwInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    kwAddFromInput();
  }
});
$("kwResetGroup").onclick = () => {
  delete kwDraft[kwGroup];
  renderKwEditor();
};
