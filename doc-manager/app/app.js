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
let selected = "";
let visible = [];
let showAllTags = false;
let searchSeq = 0;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlight(text) {
  let html = esc(text);
  const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (terms.length) html = html.replace(new RegExp(`(${terms.join("|")})`, "gi"), "<mark>$1</mark>");
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
  let h = "<h3>보기</h3>";
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
    : d.reasons.length ? `근거: ${esc(d.reasons.join(", "))}` : "분류할 단서를 찾지 못했습니다. 직접 골라 주세요.";
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
    const t = query.trim().split(/\s+/)[0];
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
    renderAll();
    return;
  }
  const r = await api.search(query);
  if (seq !== searchSeq) return;
  results = new Map(r.map((x) => [x.rel, x]));
  renderAll();
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

function openSettings() {
  $("partnersInput").value = partnersToText(S.settings.partners);
  $("rulesInput").value = rulesToText(S.settings.tagRules);
  $("settingsDlg").showModal();
}

// ---------- 이벤트 ----------

$("welcomeBtn").onclick = () => api.chooseFolder();
$("folderBtn").onclick = () => api.chooseFolder();
$("rescanBtn").onclick = () => api.rescan();
$("rootPath").onclick = () => api.openRoot();
$("settingsBtn").onclick = openSettings;
$("q").addEventListener("input", onQuery);
$("sort").onchange = renderList;
$("exportBtn").onclick = async () => {
  if (!visible.length) return toast("내보낼 문서가 없습니다.");
  if (await api.exportCsv(visible.map((d) => d.rel))) toast(`${visible.length}개 문서 목록을 저장했습니다.`);
};

$("settingsDlg").addEventListener("close", async () => {
  if ($("settingsDlg").returnValue !== "save") return;
  await api.saveSettings({ partners: textToPartners($("partnersInput").value), tagRules: textToRules($("rulesInput").value) });
  toast("설정을 저장하고 모든 문서를 다시 분류했습니다.");
});

$("side").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
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
