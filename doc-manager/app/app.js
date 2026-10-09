"use strict";

const api = window.docs;
const $ = (id) => document.getElementById(id);

const KIND_LABEL = { word: "Word", ppt: "PowerPoint", excel: "Excel", pdf: "PDF", hwp: "한글" };
const KIND_SHORT = { word: "DOC", ppt: "PPT", excel: "XLS", pdf: "PDF", hwp: "HWP" };
const GROUP_ICON = { "국가과제·지원사업": "landmark", 회사소개: "building", 홍보: "megaphone" };
const CAT_ICON = { analysis: "chart", request: "users", purchase: "cart", other: "question" };
const YEAR_RE = /^20\d{2}$/;
const DAY = 86400000;

let S = { root: "", categories: [], docs: [], scanning: false, progress: null, settings: {}, keywordGroups: [], defaultKeywords: {}, techTags: [] };
let byRel = new Map();
let catById = {};
const filter = { view: "all", tags: new Set(), kind: "", project: "" };
let query = "";
let results = null; // 검색 중이면 Map(rel → { score, snippet })
let hlTerms = []; // 검색어 중 화면에 칠할 글자
let lastImported = new Set(); // 방금 넣은 문서
let selected = "";
let visible = []; // 걸러진 문서 (버전 묶기 전)
let rowOrder = []; // 화면에 그려진 순서 (키보드 이동용)
let showAllTags = false;
let searchSeq = 0;
const expanded = new Set(); // 버전 목록을 펼친 묶음 (최신본 rel)

// 화면 설정은 이 PC 에만 기억한다. (저장이 안 되는 환경이면 그냥 넘어간다)
function pref(key, fallback) {
  try {
    const v = localStorage.getItem("docmgr." + key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try {
    localStorage.setItem("docmgr." + key, JSON.stringify(value));
  } catch {}
}
let groupVersions = pref("groupVersions", true);
const openGroups = new Set(pref("openGroups", ["국가과제·지원사업", "회사소개", "홍보"]));

// ---------- 작은 도구 ----------

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const icon = (name, cls = "") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

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

function relDate(ms) {
  const days = Math.floor((Date.now() - ms) / DAY);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 7) return `${days}일 전`;
  return fmtDate(ms);
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function folderOf(rel) {
  return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "(최상위 폴더)";
}

let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// ---------- 상태 받기 ----------

function applyState(next) {
  S = next;
  catById = Object.fromEntries(S.categories.map((c) => [c.id, c]));
  byRel = new Map(S.docs.map((d) => [d.rel, d]));
  if (selected && !byRel.has(selected)) selected = "";
  document.body.classList.toggle("mac", S.platform === "darwin");
  $("searchKbd").textContent = S.platform === "darwin" ? "⌘ K" : "Ctrl K";
  applyTheme(S.settings.theme);
  $("welcome").hidden = !!S.root;
  $("layout").hidden = !S.root;
  $("searchWrap").style.visibility = S.root ? "" : "hidden";
  $("rootPath").hidden = !S.root;
  $("rootName").textContent = S.root ? S.root.split(/[\\/]/).filter(Boolean).pop() : "";
  $("rootPath").title = S.root ? S.root + "\n(누르면 폴더 열기)" : "";
  for (const id of ["rescanBtn", "addBtn"]) $(id).disabled = !S.root;
  $("groupToggle").checked = groupVersions;
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
  st.classList.toggle("busy", !!S.scanning);
  if (S.scanning) {
    const p = S.progress;
    st.textContent = p && p.total ? `읽는 중 ${p.done}/${p.total}` : "폴더 확인 중";
    st.title = p && p.current ? p.current : "";
  } else {
    st.textContent = S.root ? `문서 ${S.docs.length.toLocaleString()}개` : "";
    st.title = "";
  }
}

// ---------- 걸러내기 ----------

function matchesView(d, view) {
  if (view === "all") return true;
  if (view === "starred") return d.starred;
  if (view === "recent") return Date.now() - d.mtimeMs < 30 * DAY;
  if (view === "imported") return lastImported.has(d.rel);
  if (view.startsWith("group:")) return (catById[d.category] || {}).group === view.slice(6);
  if (view.startsWith("cat:")) return d.category === view.slice(4);
  return true;
}

function filtered() {
  let list = S.docs.filter((d) => matchesView(d, filter.view));
  if (filter.kind) list = list.filter((d) => d.kind === filter.kind);
  if (filter.project) list = list.filter((d) => d.tags.includes(filter.project));
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
  const lead = opts.color ? `<span class="dot" style="background:${opts.color}"></span>` : opts.icon ? icon(opts.icon, "nav-icon") : "";
  return `<button class="nav-item${on}${opts.sub ? " sub" : ""}${n ? "" : " zero"}" data-view="${esc(view)}" type="button">${opts.chev ? icon("chevron", "chev") : ""}${lead}<span class="label">${esc(label)}</span><span class="n">${n}</span></button>`;
}

function renderSide() {
  const docs = S.docs;
  const count = (fn) => docs.filter(fn).length;
  let h = "";

  h += '<div class="side-label">보기</div>';
  h += navItem("all", "전체 문서", docs.length, { icon: "files" });
  h += navItem("starred", "즐겨찾기", count((d) => d.starred), { icon: "star" });
  h += navItem("recent", "최근 30일", count((d) => Date.now() - d.mtimeMs < 30 * DAY), { icon: "clock" });
  if (lastImported.size) h += navItem("imported", "방금 넣은 문서", count((d) => lastImported.has(d.rel)), { icon: "inbox" });

  const saved = S.settings.savedSearches || [];
  if (saved.length) {
    h += '<div class="side-label">저장한 검색</div>';
    saved.forEach((sv, i) => {
      h += `<div class="saved-row"><button class="nav-item" data-saved="${i}" type="button" title="${esc(savedTitle(sv))}">${icon("bookmark", "nav-icon")}<span class="label">${esc(sv.name)}</span></button><button class="x" data-unsave="${i}" type="button" aria-label="삭제" title="삭제">${icon("x")}</button></div>`;
    });
  }

  // 분류: 그룹은 접었다 펼 수 있다
  h += '<div class="side-label">분류</div>';
  const seenGroups = new Set();
  for (const c of S.categories) {
    if (c.id === "other") continue;
    if (c.group) {
      if (seenGroups.has(c.group)) continue;
      seenGroups.add(c.group);
      const cats = S.categories.filter((x) => x.group === c.group);
      const n = count((d) => (catById[d.category] || {}).group === c.group);
      h += `<div class="nav-group${openGroups.has(c.group) ? " open" : ""}" data-group="${esc(c.group)}">`;
      h += navItem("group:" + c.group, c.group, n, { icon: GROUP_ICON[c.group] || "folder", chev: true });
      h += '<div class="nav-children">';
      for (const x of cats) h += navItem("cat:" + x.id, x.label, count((d) => d.category === x.id), { sub: true, color: x.color });
      h += "</div></div>";
    } else {
      h += navItem("cat:" + c.id, c.label, count((d) => d.category === c.id), { icon: CAT_ICON[c.id] || "folder" });
    }
  }
  h += navItem("cat:other", "미분류", count((d) => d.category === "other"), { icon: CAT_ICON.other });

  // 등록한 과제
  const projects = S.settings.projects || [];
  if (projects.length) {
    h += '<div class="side-label">과제</div>';
    for (const p of projects) {
      const mine = docs.filter((d) => d.tags.includes(p.name));
      const done = mine.length && mine.every((d) => d.tags.includes("완료"));
      h += `<button class="nav-item${filter.project === p.name ? " on" : ""}${mine.length ? "" : " zero"}" data-project="${esc(p.name)}" type="button">${icon("briefcase", "nav-icon")}<span class="label">${esc(p.name)}</span>${done ? '<span class="done-pill">완료</span>' : ""}<span class="n">${mine.length}</span></button>`;
    }
  }

  const tagCount = new Map();
  for (const d of docs) for (const t of d.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const projectNames = new Set(projects.map((p) => p.name));
  const years = [...tagCount.keys()].filter((t) => YEAR_RE.test(t)).sort().reverse();
  if (years.length) {
    h += '<div class="side-label">연도</div><div class="chip-cloud">';
    for (const y of years) h += chipBtn(y, tagCount.get(y));
    h += "</div>";
  }

  const kinds = Object.keys(KIND_LABEL).filter((k) => count((d) => d.kind === k));
  if (kinds.length) {
    h += '<div class="side-label">파일 형식</div><div class="chip-cloud">';
    for (const k of kinds) h += `<button class="chip-btn${filter.kind === k ? " on" : ""}" data-kind="${k}" type="button"><span class="dot" style="background:var(--k-${k})"></span>${KIND_LABEL[k]}<small>${count((d) => d.kind === k)}</small></button>`;
    h += "</div>";
  }

  const tags = [...tagCount.entries()].filter(([t]) => !YEAR_RE.test(t) && !projectNames.has(t)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
  if (tags.length) {
    h += '<div class="side-label">태그</div><div class="chip-cloud">';
    const limit = showAllTags ? tags.length : 24;
    for (const [t, n] of tags.filter(([t], i) => i < limit || filter.tags.has(t))) h += chipBtn(t, n);
    h += "</div>";
    if (tags.length > 24) h += `<button class="more" id="moreTags" type="button">${showAllTags ? "접기" : `태그 ${tags.length - 24}개 더 보기`}</button>`;
  }

  // 여러 문서에서 핵심 키워드로 뽑힌 단어
  const kwCount = new Map();
  for (const d of docs) for (const k of d.keywords || []) kwCount.set(k, (kwCount.get(k) || 0) + 1);
  const kws = [...kwCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko")).slice(0, 20);
  if (kws.length) {
    h += '<div class="side-label" title="여러 문서에서 핵심 키워드로 뽑힌 단어. 누르면 본문 검색">자주 나오는 키워드</div><div class="chip-cloud">';
    for (const [k, n] of kws) h += `<button class="chip-btn kw" data-kw="${esc(k)}" type="button">${esc(k)}<small>${n}</small></button>`;
    h += "</div>";
  }
  const side = $("side");
  const scroll = side.scrollTop;
  side.innerHTML = h;
  side.scrollTop = scroll;
}

function chipBtn(t, n) {
  return `<button class="chip-btn${filter.tags.has(t) ? " on" : ""}" data-tag="${esc(t)}" type="button">${esc(t)}<small>${n}</small></button>`;
}

function viewLabel(view) {
  if (view === "all") return "전체 문서";
  if (view === "starred") return "즐겨찾기";
  if (view === "recent") return "최근 30일";
  if (view === "imported") return "방금 넣은 문서";
  if (view.startsWith("group:")) return view.slice(6);
  if (view.startsWith("cat:")) return catLabel(view.slice(4));
  return "";
}

function fileIcon(d) {
  return `<span class="ficon ${d.kind}">${KIND_SHORT[d.kind] || esc(d.ext.toUpperCase())}</span>`;
}

function rowHtml(d, opts = {}) {
  const c = catById[d.category] || catById.other;
  const r = results && results.get(d.rel);
  const v = d.versions;
  const isLatest = v && v.latest === d.rel;
  let vb = "";
  if (opts.child) vb = isLatest ? '<span class="latest-pill">최신</span>' : '<span class="old-pill">이전 버전</span>';
  else if (v && groupVersions) {
    vb = `<button class="vbadge${expanded.has(v.latest) ? " open" : ""}" data-family="${esc(v.latest)}" type="button" title="버전 ${v.size}개 · 눌러서 펼치기">${icon("layers")}${v.size}</button>`;
  } else if (v) vb = isLatest ? '<span class="latest-pill">최신</span>' : '<span class="old-pill">이전 버전</span>';
  const tags = opts.child ? "" : d.tags.slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  return `<li class="row${opts.child ? " child" : ""}${d.rel === selected ? " sel" : ""}" data-rel="${esc(d.rel)}" role="option" aria-selected="${d.rel === selected}">
    ${fileIcon(d)}
    <div class="row-main">
      <div class="row-title">${d.starred ? icon("star", "star") : ""}<span class="name">${highlight(d.name)}<span class="ext">.${esc(d.ext)}</span></span></div>
      <div class="row-meta"><span class="path">${esc(d.dir || "최상위 폴더")}</span><span class="sep">·</span><span>${relDate(d.mtimeMs)}</span>${opts.child ? "" : `<span class="sep">·</span><span>${fmtSize(d.size)}</span>`}</div>
      ${r && r.snippet && !opts.child ? `<div class="snippet">${highlight(r.snippet)}</div>` : ""}
      ${tags ? `<div class="row-tags">${tags}</div>` : ""}
    </div>
    <div class="row-side">
      ${opts.child ? "" : `<span class="badge${d.userCategory ? " manual" : ""}"><span class="dot" style="background:${c.color}"></span>${esc(c.label)}</span>`}
      ${vb}
    </div>
  </li>`;
}

function renderList() {
  visible = filtered();
  let f = "";
  const chip = (label, attr) => `<span class="filter-chip">${label}<button ${attr} type="button" aria-label="해제">${icon("x")}</button></span>`;
  if (filter.view !== "all") f += chip(esc(viewLabel(filter.view)), 'data-clear="view"');
  if (filter.project) f += chip(icon("briefcase") + "&nbsp;" + esc(filter.project), 'data-clear="project"');
  if (filter.kind) f += chip(KIND_LABEL[filter.kind], 'data-clear="kind"');
  for (const t of filter.tags) f += chip("#" + esc(t), `data-clear-tag="${esc(t)}"`);
  if (query) f += chip(`“${esc(query)}”`, 'data-clear="query"');
  if (f) f += `<button class="btn sm ghost" data-act="save-search" type="button" title="지금 조건을 왼쪽 '저장한 검색'에 넣습니다">${icon("bookmark")}저장</button>`;
  $("activeFilters").innerHTML = f || '<span class="title">전체 문서</span>';

  // 버전 묶기: 같은 묶음은 (지금 정렬에서) 처음 나온 문서 하나만 보여 준다.
  const rows = [];
  rowOrder = [];
  const shownFamilies = new Set();
  let families = 0;
  for (const d of visible) {
    const v = d.versions;
    if (groupVersions && v) {
      if (shownFamilies.has(v.latest)) continue;
      shownFamilies.add(v.latest);
      families++;
      rows.push(rowHtml(d));
      rowOrder.push(d.rel);
      if (expanded.has(v.latest)) {
        for (const rel of v.order) {
          if (rel === d.rel || !byRel.has(rel)) continue;
          rows.push(rowHtml(byRel.get(rel), { child: true }));
          rowOrder.push(rel);
        }
      }
    } else {
      rows.push(rowHtml(d));
      rowOrder.push(d.rel);
    }
  }
  $("count").textContent = groupVersions && families ? `${visible.length}개 · 버전 묶음 ${families}` : `${visible.length}개`;
  $("count").title = groupVersions && families ? "같은 문서의 여러 버전은 하나로 묶여 있습니다. 숫자 단추를 누르면 펼칩니다." : "";

  const list = $("list");
  const scroll = list.scrollTop;
  list.innerHTML = rows.join("");
  list.scrollTop = scroll;
  const empty = $("empty");
  empty.hidden = visible.length > 0;
  list.hidden = !visible.length;
  if (!visible.length) {
    const msg = S.scanning && !S.docs.length ? "문서를 읽는 중입니다…" : S.docs.length ? "조건에 맞는 문서가 없습니다." : "아직 문서가 없습니다. 파일을 이 창에 끌어다 놓아 보세요.";
    empty.innerHTML = `${icon(S.docs.length ? "search" : "inbox")}<div>${msg}</div>`;
  }
}

async function renderDetail() {
  const box = $("detail");
  const d = byRel.get(selected);
  if (!d) {
    box.innerHTML = `<div class="detail-empty">${icon("files")}<div>문서를 고르면 여기에 정보가 나옵니다.<br><small>두 번 누르면 파일이 열립니다.</small></div></div>`;
    return;
  }
  const opts = [`<option value="">자동: ${esc(catLabel(d.autoCategory))}</option>`]
    .concat(S.categories.map((c) => `<option value="${c.id}"${d.userCategory === c.id ? " selected" : ""}>${esc(catLabel(c.id))}</option>`))
    .join("");
  const reason = d.userCategory
    ? `직접 고른 분류입니다. <button data-act="reset-cat" type="button">자동 분류로 되돌리기</button>`
    : (d.reasons.length ? `근거: ${esc(d.reasons.join(", "))}` : "분류할 단서를 찾지 못했습니다. 직접 골라 주세요.") +
      ` · <button data-act="edit-keywords" type="button">분류 키워드 고치기</button>`;
  const userSet = new Set(d.userTags);
  const tagChips = d.tags.map((t) => `<span class="tag${userSet.has(t) ? " user" : ""}">${esc(t)}<button data-untag="${esc(t)}" type="button" aria-label="${esc(t)} 태그 빼기">${icon("x")}</button></span>`).join("");
  const hiddenTags = d.hiddenTags.length
    ? `<div class="restore-row">뺀 자동 태그: ${d.hiddenTags.map((t) => `<button data-retag="${esc(t)}" type="button" title="다시 붙이기">${esc(t)} ↺</button>`).join("")}</div>`
    : "";
  const info = [
    ["형식", KIND_LABEL[d.kind] + (d.pages ? ` · ${d.pages}${d.kind === "ppt" ? "장" : "쪽"}` : "")],
    ["크기", fmtSize(d.size)],
    ["수정일", fmtDate(d.mtimeMs)],
    ["만든 날", fmtDate(d.birthtimeMs)],
    d.title ? ["문서 제목", d.title] : null,
    d.author ? ["작성자", d.author] : null,
  ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

  const v = d.versions;
  let banner = "";
  let timeline = "";
  if (v) {
    const latest = byRel.get(v.latest);
    if (v.latest !== d.rel && latest) {
      banner = `<div class="banner">${icon("info")}<div>더 최신 버전이 있습니다: <b>${esc(latest.base)}</b> (${fmtDate(latest.mtimeMs)}) <button data-goto="${esc(latest.rel)}" type="button">보기</button></div></div>`;
    }
    timeline = `<div class="card"><h4>${icon("layers")}버전 기록<small>${v.size}개</small></h4><ul class="timeline">${v.order
      .filter((rel) => byRel.has(rel))
      .map((rel) => {
        const x = byRel.get(rel);
        return `<li class="${rel === d.rel ? "cur" : ""}"><button data-goto="${esc(rel)}" type="button" title="${esc(rel)}"><span class="tl-dot"></span><span class="tl-name">${esc(x.base)}</span><span class="tl-date">${fmtDate(x.mtimeMs)}</span></button></li>`;
      })
      .join("")}</ul></div>`;
  }

  box.innerHTML = `
    <div class="d-head">${fileIcon(d)}<div><h2>${esc(d.base)}</h2><div class="d-path">${esc(d.dir ? d.dir + "/" : "최상위 폴더")}</div></div></div>
    ${banner}
    <div class="d-actions">
      <button class="btn primary" data-act="open" type="button">${icon("external")}열기</button>
      <button class="btn" data-act="new-version" type="button" title="${v && v.latest !== d.rel ? "이 (이전) 버전을 복사해서" : "이 문서를 복사해서"} 다음 버전 이름으로 저장하고 엽니다. 원본은 그대로 남습니다.">${icon("layers")}새 버전으로 고치기</button>
      <button class="icon-btn" data-act="reveal" type="button" title="폴더에서 보기" aria-label="폴더에서 보기">${icon("folder-open")}</button>
      <button class="icon-btn${d.starred ? " on" : ""}" data-act="star" type="button" title="${d.starred ? "즐겨찾기 해제" : "즐겨찾기"}" aria-label="즐겨찾기">${d.starred ? '<svg style="fill:currentColor"><use href="#i-star"/></svg>' : icon("star")}</button>
    </div>
    <div class="card">
      <h4>${icon("folder")}분류</h4>
      <select class="select" id="catSelect">${opts}</select>
      <div class="reason">${reason}</div>
      ${d.expectedDir && d.dir !== d.expectedDir
        ? `<div class="move-hint"><span>분류 폴더와 다른 곳에 있습니다.</span><button class="btn sm" data-act="move" type="button" title="문서 폴더 안에서 옮깁니다. 태그·메모는 그대로 따라갑니다.">${icon("move")}${esc(d.expectedDir)} 폴더로 옮기기</button></div>`
        : ""}
    </div>
    ${timeline}
    <div class="card">
      <h4>${icon("hash")}태그</h4>
      <div class="tag-edit">${tagChips}<input class="tag-input" id="tagInput" placeholder="+ 태그" list="allTags"></div>
      <datalist id="allTags">${allTags().map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
      ${hiddenTags}
      <label class="ai-toggle" title="켜면 Claude 커넥터가 이 문서를 검색하거나 읽을 수 없습니다 ('AI제외' 태그)"><input type="checkbox" id="aiExcludeToggle" ${d.tags.includes("AI제외") ? "checked" : ""}>${icon("shield")}Claude 에 보내지 않기</label>
    </div>
    <div class="card">
      <h4>${icon("sparkle")}핵심 키워드<small>누르면 검색 · ＋는 태그로</small></h4>
      ${d.keywords && d.keywords.length
        ? `<div class="kw-list">${d.keywords.map((k) => `<span class="kw-chip"><button data-kwsearch="${esc(k)}" type="button">${esc(k)}</button><button class="plus" data-kwtag="${esc(k)}" type="button" title="태그로 붙이기" aria-label="${esc(k)} 태그로 붙이기">＋</button></span>`).join("")}</div>`
        : '<div class="muted small">뽑을 만한 단어가 없습니다.</div>'}
    </div>
    <div class="card">
      <h4>${icon("bookmark")}메모</h4>
      <textarea class="note" id="noteInput" placeholder="예: 2025.3 KEIT 제출본, 대표님 검토 완료">${esc(d.note)}</textarea>
    </div>
    <div class="card">
      <h4>${icon("info")}정보</h4>
      <dl class="info">${info}</dl>
    </div>
    <div class="card">
      <h4>${icon("files")}본문 미리보기</h4>
      ${d.error ? `<p class="warn">본문을 읽지 못했습니다 (암호가 걸렸거나 손상된 파일일 수 있습니다). 파일 이름으로만 분류했습니다.</p>` : ""}
      ${d.protectedText ? `<p class="warn">암호가 걸렸거나 배포용으로 저장된 한글 문서라 앞부분(약 1쪽)만 읽었습니다. 일반 문서로 다시 저장하면 전체를 읽습니다.</p>` : ""}
      ${d.hasText ? '<pre class="preview" id="preview">불러오는 중…</pre>' : !d.error ? `<div class="muted small">${["ppt", "xls"].includes(d.ext) ? "옛 형식(." + esc(d.ext) + ")은 본문을 읽지 않고 파일 이름으로만 분류합니다. ." + esc(d.ext) + "x 로 저장하면 본문까지 읽습니다." : "본문 글자가 없습니다. (스캔한 PDF, 그림만 있는 문서 등)"}</div>` : ""}
    </div>`;

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

// 다른 버전으로 이동: 목록에서 안 보이면 그 묶음을 펼친다.
function goto(rel) {
  const d = byRel.get(rel);
  if (!d) return;
  if (d.versions && groupVersions) expanded.add(d.versions.latest);
  selected = rel;
  renderList();
  select(rel, true);
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

let rememberTimer = null;
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

function rememberSearch(q) {
  q = q.trim();
  if (!q) return;
  const recent = (S.settings.recentSearches || []).filter((x) => x !== q);
  recent.unshift(q);
  S.settings.recentSearches = recent.slice(0, 15);
  api.saveSearches({ recentSearches: S.settings.recentSearches });
}

function savedTitle(sv) {
  const parts = [];
  if (sv.view && sv.view !== "all") parts.push(viewLabel(sv.view));
  if (sv.project) parts.push(sv.project);
  if (sv.kind) parts.push(KIND_LABEL[sv.kind]);
  for (const t of sv.tags || []) parts.push("#" + t);
  if (sv.q) parts.push(`“${sv.q}”`);
  return parts.join(" · ") || "전체 문서";
}

function saveCurrentSearch() {
  const sv = { q: query, view: filter.view, tags: [...filter.tags], kind: filter.kind, project: filter.project };
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
  filter.project = sv.project || "";
  setQuery(sv.q || "");
}

function removeSaved(i) {
  const saved = [...(S.settings.savedSearches || [])];
  saved.splice(i, 1);
  S.settings.savedSearches = saved;
  api.saveSearches({ savedSearches: saved });
  renderSide();
}

function showSuggest() {
  const box = $("suggest");
  const recent = S.settings.recentSearches || [];
  let h = "";
  if (recent.length) {
    h += '<div class="sg-head">최근 검색<button class="link" data-clear-recent type="button">모두 지우기</button></div>';
    h += recent.slice(0, 8).map((q) => `<button class="sg-item" data-recent="${esc(q)}" type="button">${icon("clock")}${esc(q)}</button>`).join("");
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

function linesToNamed(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, rest = ""] = l.split("=");
    return { name: name.trim(), aliases: splitList(rest) };
  }).filter((p) => p.name);
}

function namedToLines(list) {
  return (list || []).map((p) => (p.aliases && p.aliases.length ? `${p.name} = ${p.aliases.join(", ")}` : p.name)).join("\n");
}

function rulesToText(list) {
  return (list || []).map((r) => (r.keywords && r.keywords.length ? `${r.tag}: ${r.keywords.join(", ")}` : r.tag)).join("\n");
}

function splitList(s) {
  return s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
}

function textToRules(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.search(/[:：]/);
    return i < 0 ? { tag: l, keywords: [] } : { tag: l.slice(0, i).trim(), keywords: splitList(l.slice(i + 1)) };
  }).filter((r) => r.tag);
}

// 분류 키워드 편집: 편집하는 동안은 kwDraft 에 담아 두고, 저장을 누르면 settings.keywordOverrides 로 보낸다.
let kwDraft = {};
let kwGroup = "gov_plan";
const weightLabel = (w) => (w >= 6 ? "강함" : w >= 4 ? "보통" : "약함");
const normKw = (k) => k.replace(/\s+/g, "").toLowerCase();

function renderKwEditor() {
  const g = kwGroup;
  const o = kwDraft[g] || { add: [], remove: [] };
  const removed = new Set((o.remove || []).map(normKw));
  const added = new Map((o.add || []).map(([k, w]) => [normKw(k), [k, w]]));
  const base = (S.defaultKeywords[g] || []).filter(([k]) => !added.has(normKw(k)));
  const chips = [];
  for (const [k, w] of added.values()) chips.push(`<span class="kwe user" title="내가 넣은 키워드">${esc(k)}<i>${weightLabel(w)}</i><button data-kwdel="${esc(k)}" type="button" aria-label="빼기">${icon("x")}</button></span>`);
  for (const [k, w] of base) {
    if (removed.has(normKw(k))) continue;
    chips.push(`<span class="kwe" title="기본 키워드">${esc(k)}<i>${weightLabel(w)}</i><button data-kwdel="${esc(k)}" type="button" aria-label="빼기">${icon("x")}</button></span>`);
  }
  const off = base.filter(([k]) => removed.has(normKw(k)));
  $("kwChips").innerHTML = chips.join("") || '<span class="muted">키워드가 없습니다.</span>';
  $("kwRemoved").innerHTML = off.length ? "뺀 기본 키워드: " + off.map(([k]) => `<button data-kwrestore="${esc(k)}" type="button" title="되살리기">${esc(k)} ↺</button>`).join("") : "";
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
  // 내가 넣은 키워드가 기본 키워드의 세기만 바꾼 것이었다면 기본값으로 돌아가고, 아니면 뺀다.
  if (isBase && !wasAdded) o.remove = [...new Set([...(o.remove || []), k])];
  renderKwEditor();
}

function kwRestore(k) {
  const o = kwDraft[kwGroup];
  if (o) o.remove = (o.remove || []).filter((x) => normKw(x) !== normKw(k));
  renderKwEditor();
}

// ---- Claude 연결 탭 ----
const TOOL_LABEL = {
  library_overview: "둘러보기", search_documents: "검색", read_document: "읽기", list_versions: "버전 기록",
  find_related_documents: "관련 문서", save_new_version: "새 버전 저장", prepare_new_version: "새 버전 복사본",
  get_knowledge: "지식 카드 읽기", save_knowledge_card: "지식 카드 저장",
};

async function renderClaudeTab() {
  const st = await api.claudeStatus();
  const main = st.targets[0] || {};
  const anyBad = st.targets.find((t) => t.error);
  const connected = st.targets.some((t) => t.connected);
  const stale = st.targets.some((t) => t.connected && !t.matches);
  $("claudeState").innerHTML = anyBad
    ? `<span class="state-warn">${esc(anyBad.error)}</span>`
    : connected
      ? stale
        ? `<span class="state-warn">연결되어 있지만 예전 위치를 가리킵니다. '다시 연결'을 눌러 주세요.</span>`
        : `<span class="state-on">연결됨</span> · Claude 앱을 다시 켜면 '문서 보관함' 도구가 보입니다.`
      : `연결되어 있지 않습니다. <span class="muted">(${esc(main.path || "")})</span>`;
  $("claudeConnectBtn").textContent = connected ? "다시 연결" : "연결";
  $("claudeDisconnectBtn").hidden = !connected;
  $("claudeCodeCmd").textContent = st.claudeCode;
  renderKnowledge();
  // 제외할 분류
  const excluded = new Set(S.settings.aiExcludeCategories || []);
  $("aiExcludeList").innerHTML = S.categories
    .map((c) => `<label class="check"><input type="checkbox" data-aiex="${c.id}" ${excluded.has(c.id) ? "checked" : ""}><span>${esc(catLabel(c.id))}</span></label>`)
    .join("");
  // 기록
  const log = await api.aiLog();
  const time = (iso) => {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  $("aiLogList").innerHTML = log.length
    ? log
        .map((l) => {
          const what = l.error ? `<span class="err">${esc(l.error)}</span>` : esc(l.new_path ? `${l.path} → ${l.new_path}${l.change_summary ? " (" + l.change_summary + ")" : ""}` : l.query !== undefined ? `“${l.query}”` : l.path || "");
          return `<li><span class="t">${time(l.time)}</span><span class="k">${esc(TOOL_LABEL[l.tool] || l.tool)}</span><span class="d" title="${esc(l.path || l.query || "")}">${what}</span></li>`;
        })
        .join("")
    : '<li><span class="empty-log">아직 Claude 가 이 보관함을 쓴 기록이 없습니다.</span></li>';
}

$("claudeConnectBtn").onclick = async () => {
  const r = await api.claudeConnect();
  if (r.error) toast(r.error, 7000);
  else toast("Claude 데스크톱 설정에 문서 보관함을 넣었습니다.\nClaude 앱을 완전히 종료했다가 다시 켜 주세요.", 7000);
  renderClaudeTab();
};
$("claudeDisconnectBtn").onclick = async () => {
  const r = await api.claudeDisconnect();
  if (r.error) toast(r.error, 7000);
  else toast("Claude 연결을 해제했습니다. Claude 앱을 다시 켜면 적용됩니다.");
  renderClaudeTab();
};
$("claudeTestBtn").onclick = async () => {
  const btn = $("claudeTestBtn");
  const box = $("claudeTestResult");
  btn.disabled = true;
  btn.textContent = "테스트 중…";
  box.hidden = false;
  box.innerHTML = '<p class="hint">커넥터를 Claude 와 같은 방법으로 실행해 보는 중…</p>';
  try {
    const { test, logs, targets } = await api.claudeTest();
    const rows = [];
    rows.push(
      test.ok
        ? `<p><span class="state-on">✔ 커넥터 정상</span> · 도구 ${test.tools.length}개, 보이는 문서 ${test.documents ?? "?"}개 (${(test.ms / 1000).toFixed(1)}초)</p>`
        : `<p><span class="state-warn">✖ 커넥터를 실행하지 못했습니다</span>: ${esc(test.error)}</p>${test.stderr ? `<pre>${esc(test.stderr)}</pre>` : ""}`
    );
    targets.forEach((t, i) => {
      const lg = logs[i] || {};
      rows.push(`<p class="hint"><b>Claude 설정</b> ${t.connected ? "✔ 들어 있음" : "✖ 없음"} — <code>${esc(t.path)}</code></p>`);
      rows.push(
        lg.exists
          ? `<p class="hint"><b>Claude 가 커넥터를 실행한 기록</b> (마지막 ${esc(new Date(lg.modified).toLocaleString())}) — <code>${esc(lg.file)}</code></p><pre>${esc(lg.tail)}</pre>`
          : `<p class="hint"><b>Claude 가 커넥터를 실행한 기록 없음</b> — Claude 앱이 이 설정을 아직 읽지 않았습니다. Claude 를 트레이 아이콘에서 완전히 종료한 뒤 다시 켜 보세요. 그래도 없으면 Claude 가 다른 위치의 설정을 쓰는 설치판일 수 있습니다.</p>`
      );
    });
    box.innerHTML = rows.join("");
  } catch (e) {
    box.innerHTML = `<p class="state-warn">${esc(String(e))}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "연결 테스트";
  }
};
// ---- 회사 지식 카드 ----
async function renderKnowledge() {
  const k = await api.knowledgeGet();
  if (k.error) {
    $("knowledgeState").textContent = k.error;
    return;
  }
  $("knowledgeState").innerHTML = k.exists
    ? `<span class="state-on">있음</span> · 마지막으로 고친 때 ${esc(new Date(k.updated).toLocaleString())} · ${(k.content.length / 1000).toFixed(1)}천 자`
    : "아직 없습니다. 아래 문장으로 Claude 에게 만들어 달라고 해 보세요.";
  return k;
}
$("knowledgeEditBtn").onclick = async () => {
  const k = await api.knowledgeGet();
  if (k.error) return toast(k.error);
  $("knowledgeText").value = k.exists ? k.content : k.template;
  $("knowledgeEditor").hidden = false;
  $("knowledgeText").focus();
};
$("knowledgeCancelBtn").onclick = () => ($("knowledgeEditor").hidden = true);
$("knowledgeSaveBtn").onclick = async () => {
  const r = await api.knowledgeSave($("knowledgeText").value);
  if (r.error) return toast(r.error, 6000);
  toast(r.backup ? "지식 카드를 저장했습니다. 이전 내용은 기록으로 남겼습니다." : "지식 카드를 저장했습니다.");
  $("knowledgeEditor").hidden = true;
  renderKnowledge();
};
$("knowledgeOpenBtn").onclick = async () => {
  const r = await api.knowledgeOpen();
  if (r.error) toast(r.error);
  renderKnowledge();
};
$("copyKnowledgePromptBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("knowledgePrompt").textContent);
    toast("복사했습니다. Claude 데스크톱 일반 채팅에 붙여 넣으세요.");
  } catch {
    toast("복사하지 못했습니다. 글자를 직접 선택해 복사해 주세요.");
  }
};
$("copyCmdBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("claudeCodeCmd").textContent);
    toast("명령을 복사했습니다. 터미널에 붙여 넣으세요.");
  } catch {
    toast("복사하지 못했습니다. 글자를 직접 선택해 복사해 주세요.");
  }
};

function setSettingsTab(tab) {
  if (tab === "claude") renderClaudeTab();
  for (const b of document.querySelectorAll(".settings-nav button")) b.classList.toggle("on", b.dataset.tab === tab);
  for (const p of document.querySelectorAll(".tab-panel")) p.hidden = p.dataset.panel !== tab;
}

function openSettings(tab = "general", group) {
  $("aiExcludeList").innerHTML = ""; // 열 때마다 새로 그린다 (Claude 탭을 열면)
  const st = S.settings;
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === (st.theme || "system");
  for (const r of document.querySelectorAll('input[name="importLayout"]')) r.checked = r.value === (st.importLayout || "category");
  $("techTagsInput").checked = st.techTags !== false;
  $("techTagsHint").textContent = "붙이는 태그: " + (S.techTags || []).map((t) => t.tag).join(", ") + ". 개별 문서에서 빼거나, '내 태그 규칙'으로 더할 수 있습니다.";
  $("projectsInput").value = namedToLines(st.projects);
  $("partnersInput").value = namedToLines(st.partners);
  $("rulesInput").value = rulesToText(st.tagRules);
  kwDraft = JSON.parse(JSON.stringify(st.keywordOverrides || {}));
  if (group) kwGroup = group;
  $("kwGroups").innerHTML = S.keywordGroups.map((g) => `<button type="button" data-group="${g.key}">${esc(g.label)}</button>`).join("");
  renderKwEditor();
  $("aboutVersion").textContent = S.appVersion || "";
  $("aboutRoot").textContent = S.root || "(아직 고르지 않음)";
  $("aboutStore").textContent = !S.root
    ? ""
    : S.indexInFolder
      ? "문서 폴더 안 .docmanager 폴더에 저장합니다. 직접 고친 분류·태그·메모와 과제·고객사·태그 규칙·분류 키워드가 폴더를 따라가므로, 폴더를 옮기거나 Google Drive 등으로 다른 PC에서 열어도 그대로입니다. (테마·최근 검색은 PC마다 따로)"
      : "문서 폴더에 쓸 수 없어서 이 PC에 저장하고 있습니다. 다른 PC에서는 보이지 않습니다.";
  setSettingsTab(tab);
  $("settingsDlg").showModal();
}

// ---------- 끌어다 놓기 · 문서 넣기 ----------

function showImportResult(r) {
  if (!r) return;
  if (r.error) return toast(r.error);
  const lines = [];
  if (r.imported.length) {
    const byFolder = new Map();
    for (const x of r.imported) byFolder.set(folderOf(x.rel), (byFolder.get(folderOf(x.rel)) || 0) + 1);
    lines.push(`${r.imported.length}개를 저장하고 분류했습니다.`);
    for (const [f, n] of byFolder) lines.push(`· ${f}  ${n}개`);
  }
  if (r.existing.length) lines.push(`${r.existing.length}개는 이미 문서 폴더에 있어서 복사하지 않았습니다.`);
  if (r.skipped.length) lines.push(`${r.skipped.length}개는 넣지 못했습니다: ` + r.skipped.slice(0, 3).map((x) => `${x.name} (${x.reason})`).join(", ") + (r.skipped.length > 3 ? " …" : ""));
  if (!lines.length) lines.push("넣을 문서가 없습니다.");
  toast(lines.join("\n"), 6500);

  const rels = [...r.imported, ...r.existing].map((x) => x.rel);
  if (!rels.length) return;
  lastImported = new Set(rels);
  // 넣은 문서만 보이게 하고 첫 문서를 고른다. (분류가 틀렸으면 오른쪽에서 바로 고칠 수 있게)
  filter.view = "imported";
  filter.tags.clear();
  filter.kind = "";
  filter.project = "";
  if (query) {
    $("q").value = "";
    query = "";
    results = null;
    hlTerms = [];
    if ($("sort").value === "relevance") $("sort").value = "mtime";
  }
  selected = rels[0];
  renderAll(true);
}

// ---------- 이벤트 ----------

$("welcomeBtn").onclick = () => api.chooseFolder();
$("folderBtn").onclick = () => api.chooseFolder();
$("rescanBtn").onclick = () => api.rescan();
$("rootPath").onclick = () => api.openRoot();
$("settingsBtn").onclick = () => openSettings();
// 문서 넣기: 단추는 파일 고르기, ▾ 메뉴에서 폴더째 넣기
async function pickAndImport(kind) {
  closeAddMenu();
  showImportResult(await api.pickAndImport(kind));
}
function closeAddMenu() {
  $("addMenu").hidden = true;
  $("addMenuBtn").setAttribute("aria-expanded", "false");
}
$("addBtn").onclick = () => pickAndImport("files");
$("addMenuBtn").onclick = (e) => {
  e.stopPropagation();
  const open = $("addMenu").hidden;
  $("addMenu").hidden = !open;
  $("addMenuBtn").setAttribute("aria-expanded", String(open));
};
$("addMenu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick]");
  if (b) pickAndImport(b.dataset.pick);
});
document.addEventListener("click", (e) => {
  if (!$("addMenu").hidden && !e.target.closest("#addSplit")) closeAddMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("addMenu").hidden) closeAddMenu();
});

// 여러 개를 넣는 동안 진행 상황
function showProgress(p) {
  if (!p || !p.total || p.done >= p.total) return;
  const t = $("toast");
  const pct = Math.round((p.done / p.total) * 100);
  t.innerHTML = `<div class="prog"><div class="prog-top"><span>문서 넣는 중</span><span>${p.done + 1} / ${p.total}</span></div><div class="prog-name">${esc(p.current)}</div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 60000);
}
$("sort").onchange = renderList;
$("groupToggle").onchange = (e) => {
  groupVersions = e.target.checked;
  setPref("groupVersions", groupVersions);
  renderList();
  renderDetail();
};
$("exportBtn").onclick = async () => {
  if (!visible.length) return toast("내보낼 문서가 없습니다.");
  if (await api.exportCsv(visible.map((d) => d.rel))) toast(`${visible.length}개 문서 목록을 저장했습니다.`);
};

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
  } else if (e.key === "Escape") {
    if ($("q").value) {
      $("q").value = "";
      onQuery();
    } else $("q").blur();
  } else if (e.key === "ArrowDown" && rowOrder.length) {
    e.preventDefault();
    $("q").blur();
    select(rowOrder[0], true);
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

$("side").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.saved !== undefined) return applySaved(S.settings.savedSearches[+b.dataset.saved]);
  if (b.dataset.unsave !== undefined) return removeSaved(+b.dataset.unsave);
  if (b.dataset.kw) return setQuery(kwQuery(b.dataset.kw));
  if (b.id === "moreTags") showAllTags = !showAllTags;
  else if (b.dataset.view) {
    const v = b.dataset.view;
    // 그룹 줄을 누르면 펼치고, 이미 고른 그룹을 다시 누르면 접는다
    if (v.startsWith("group:")) {
      const g = v.slice(6);
      if (filter.view === v && openGroups.has(g)) openGroups.delete(g);
      else openGroups.add(g);
      setPref("openGroups", [...openGroups]);
    }
    filter.view = v;
  } else if (b.dataset.project !== undefined) filter.project = filter.project === b.dataset.project ? "" : b.dataset.project;
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
  if (b.dataset.clear === "project") filter.project = "";
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
  const vb = e.target.closest("[data-family]");
  if (vb) {
    const k = vb.dataset.family;
    expanded.has(k) ? expanded.delete(k) : expanded.add(k);
    renderList();
    return;
  }
  const li = e.target.closest(".row");
  if (li) select(li.dataset.rel);
});
$("list").addEventListener("dblclick", (e) => {
  if (e.target.closest("[data-family]")) return;
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
  if (b.dataset.goto) return goto(b.dataset.goto);
  if (act === "move") {
    const r = await api.moveToCategory(d.rel);
    if (r.error) return toast("옮기지 못했습니다: " + r.error);
    if (lastImported.delete(d.rel)) lastImported.add(r.rel);
    selected = r.rel;
    renderAll(true);
    return toast(`${folderOf(r.rel)} 폴더로 옮겼습니다.`);
  }
  if (act === "new-version") {
    b.disabled = true;
    const r = await api.newVersion(d.rel);
    b.disabled = false;
    if (r.error) return toast("새 버전을 만들지 못했습니다: " + r.error);
    goto(r.rel);
    return toast(`새 버전 '${r.rel.split("/").pop()}'을(를) 만들고 열었습니다.\n원본은 그대로 남아 있고, 버전 기록에 함께 묶입니다.` + (r.openError ? `\n(파일을 열지 못했습니다: ${r.openError})` : ""), 6000);
  }
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
  if (e.target.id === "aiExcludeToggle") {
    if (e.target.checked) await addTag(d, "AI제외");
    else await removeTag(d, "AI제외");
    return;
  }
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
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "f")) {
    e.preventDefault();
    $("q").focus();
    $("q").select();
    return;
  }
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || $("settingsDlg").open) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!rowOrder.length) return;
    e.preventDefault();
    let i = rowOrder.indexOf(selected);
    i = e.key === "ArrowDown" ? Math.min(rowOrder.length - 1, i + 1) : Math.max(0, i - 1);
    select(rowOrder[i], true);
  } else if (e.key === "Enter" && selected) {
    openDoc(selected);
  } else if (e.key === "/" ) {
    e.preventDefault();
    $("q").focus();
  }
});

// 설정 창
document.querySelector(".settings-nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) setSettingsTab(b.dataset.tab);
});
$("themeSeg").addEventListener("change", (e) => applyTheme(e.target.value)); // 고르는 즉시 미리 보기
$("settingsDlg").addEventListener("close", async () => {
  if ($("settingsDlg").returnValue !== "save") {
    applyTheme(S.settings.theme);
    return;
  }
  const checked = (name) => (document.querySelector(`input[name="${name}"]:checked`) || {}).value;
  await api.saveSettings({
    theme: checked("theme"),
    importLayout: checked("importLayout"),
    techTags: $("techTagsInput").checked,
    projects: linesToNamed($("projectsInput").value),
    partners: linesToNamed($("partnersInput").value),
    tagRules: textToRules($("rulesInput").value),
    keywordOverrides: kwDraft,
    // Claude 탭을 열지 않았으면 체크 상자가 없으므로 지금 값을 그대로 둔다
    aiExcludeCategories: $("aiExcludeList").children.length
      ? [...document.querySelectorAll("[data-aiex]:checked")].map((x) => x.dataset.aiex)
      : S.settings.aiExcludeCategories || [],
  });
  toast("설정을 저장하고 모든 문서를 다시 분류했습니다.");
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

// 끌어다 놓기
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("dropHint").textContent = S.root
    ? S.settings.importLayout === "root" ? "문서 폴더 바로 아래에 저장" : "분류에 맞는 폴더에 저장 (예: 국가과제·지원사업 / 5 보고서)"
    : "먼저 문서 폴더를 골라 주세요";
  $("dropZone").hidden = false;
});
window.addEventListener("dragover", (e) => {
  // 기본 동작(파일을 창에서 열기)을 막아야 놓을 수 있다.
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = S.root ? "copy" : "none";
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("dropZone").hidden = true;
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("dropZone").hidden = true;
  if (!S.root) return toast("먼저 문서 폴더를 골라 주세요.");
  const paths = api.droppedPaths();
  if (!paths.length) {
    // 메일 첨부·웹 페이지처럼 디스크에 파일이 없는 곳에서 끌어온 경우
    return toast("놓은 것에서 파일을 찾지 못했습니다.\n탐색기(Finder)의 파일이나 폴더를 끌어다 놓거나, '문서 넣기'로 골라 주세요.", 6000);
  }
  toast(`넣을 문서를 찾는 중… (${paths.length}개 항목)`, 60000);
  showImportResult(await api.importFiles(paths));
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
api.onImportProgress(showProgress);

api.getState().then(applyState);
